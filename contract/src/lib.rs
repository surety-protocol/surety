//! Surety core contract (docs/SPEC.md section 4, MECHANISM.md).
//!
//! Every rule mirrors `shared/src/mock-chain.ts`, the in-memory reference that the
//! judge, agents, simulation and dashboard are tested against. Payouts use
//! `ft_transfer` with a callback; a failed transfer is credited to `claimable`
//! and can be pulled later with `claim`, so no tokens get stuck.

use near_sdk::{
    collections::{LookupMap, UnorderedMap, Vector},
    env, ext_contract,
    json_types::U128,
    near, require,
    serde::Deserialize,
    serde_json::{self, json},
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, PromiseOrValue,
};

pub mod agent;
pub mod config;
pub mod events;
pub mod job;
pub mod pricing;

#[cfg(test)]
mod tests;

use agent::{AgentRecord, AgentView, BackerView};
pub use config::Config;
use events::emit;
use job::{Appeal, Job, JobStatus, JobView, Settlement, Verdict};
use pricing::{
    apply_pool_gain, apply_pool_loss, can_accept, failure_rate_bps, is_sha256_hex, job_weight, premium_bps,
    score_from_counts, settle as settle_math, update_record, Backer, Outcome, SettleInput,
};

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_ON_PAYOUT: Gas = Gas::from_tgas(5);

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Agents,
    Jobs,
    PairCounts,
    Claimable,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", tag = "action", rename_all = "snake_case")]
enum TransferMsg {
    Bond,
    Pool { agent_id: AccountId },
    PostJob { spec_hash: String, spec_url: String, min_score_bps: Option<u32>, deadline_ms: u64 },
    Appeal { job_id: u64 },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct SuretyCore {
    token_id: AccountId,
    judge_id: AccountId,
    panel_id: AccountId,
    config: Config,
    agents: UnorderedMap<AccountId, AgentRecord>,
    /// job_id is the index.
    jobs: Vector<Job>,
    /// "agent|client" -> settled jobs between them (k in value / k).
    pair_counts: LookupMap<String, u64>,
    /// Payouts whose ft_transfer failed, waiting for `claim`.
    claimable: LookupMap<AccountId, u128>,
}

fn now() -> u64 {
    env::block_timestamp_ms()
}

#[near]
impl SuretyCore {
    #[init]
    pub fn new(token_id: AccountId, judge_id: AccountId, panel_id: AccountId, config: Option<Config>) -> Self {
        let config = config.unwrap_or_default();
        config.validate();
        Self {
            token_id,
            judge_id,
            panel_id,
            config,
            agents: UnorderedMap::new(StorageKey::Agents),
            jobs: Vector::new(StorageKey::Jobs),
            pair_counts: LookupMap::new(StorageKey::PairCounts),
            claimable: LookupMap::new(StorageKey::Claimable),
        }
    }

    // ---------- money in (SPEC 4.2) ----------

    /// NEP-141 receiver. Keeps all tokens (returns 0); panics on a bad msg so the
    /// token contract refunds the sender.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.token_id, "only the tUSDC token contract can call this");
        let value = amount.0;
        require!(value > 0, "amount must be positive");
        let parsed: TransferMsg = serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("unknown msg action"));
        match parsed {
            TransferMsg::Bond => {
                let mut a = self.agents.get(&sender_id).unwrap_or_else(|| env::panic_str("only a registered agent can post a bond"));
                a.bond += value;
                self.agents.insert(&sender_id, &a);
                emit("bond_deposited", json!({ "agent_id": sender_id, "amount": amount, "bond": U128(a.bond) }));
            }
            TransferMsg::Pool { agent_id } => {
                let mut a = self.agents.get(&agent_id).unwrap_or_else(|| env::panic_str("unknown agent"));
                require!(agent_id != sender_id, "an agent cannot back itself; use bond");
                if let Some(b) = a.backers.iter_mut().find(|b| b.backer_id == sender_id) {
                    b.amount += value;
                } else {
                    require!(
                        (a.backers.len() as u32) < self.config.max_backers_per_agent,
                        "too many backers for this agent"
                    );
                    a.backers.push(Backer { backer_id: sender_id.clone(), amount: value });
                }
                self.agents.insert(&agent_id, &a);
                emit("pool_deposited", json!({ "agent_id": agent_id, "backer_id": sender_id, "amount": amount }));
            }
            TransferMsg::PostJob { spec_hash, spec_url, min_score_bps, deadline_ms } => {
                let min = min_score_bps.unwrap_or(self.config.default_min_score_bps);
                require!(is_sha256_hex(&spec_hash), "spec_hash must be 64 lowercase hex characters");
                require!(!spec_url.is_empty(), "spec_url is required");
                require!((1..=10_000).contains(&min), "min_score_bps must be 1..10000");
                require!(deadline_ms > now(), "deadline_ms must be in the future");
                let job_id = self.jobs.len();
                self.jobs.push(&Job {
                    job_id,
                    client_id: sender_id.clone(),
                    value,
                    spec_hash: spec_hash.clone(),
                    spec_url,
                    min_score_bps: min,
                    deadline_ms,
                    posted_ms: now(),
                    status: JobStatus::Open,
                    agent_id: None,
                    premium_bps: None,
                    patch_url: None,
                    patch_hash: None,
                    verdict: None,
                    appeal: None,
                    settlement: None,
                });
                emit("job_posted", json!({ "job_id": job_id, "client_id": sender_id, "value": amount, "spec_hash": spec_hash }));
            }
            TransferMsg::Appeal { job_id } => {
                let mut j = self.job(job_id);
                require!(j.status == JobStatus::Judged, "only a judged job can be appealed");
                require!(j.appeal.is_none(), "job already appealed");
                let v = j.verdict.clone().unwrap();
                require!(now() < v.appeal_deadline_ms, "appeal window closed");
                require!(
                    sender_id == j.client_id || Some(&sender_id) == j.agent_id.as_ref(),
                    "only the client or the agent can appeal"
                );
                require!(value == self.config.appeal_deposit.0, "appeal deposit must equal config.appeal_deposit");
                j.appeal = Some(Appeal {
                    appellant_id: sender_id.clone(),
                    deposit: value,
                    original_score_bps: v.score_bps,
                    resolved: false,
                });
                j.status = JobStatus::Appealed;
                self.jobs.replace(job_id, &j);
                emit("job_appealed", json!({ "job_id": job_id, "appellant_id": sender_id, "deposit": amount }));
            }
        }
        PromiseOrValue::Value(U128(0))
    }

    // ---------- change methods (SPEC 4.3) ----------

    pub fn register_agent(&mut self) {
        let caller = env::predecessor_account_id();
        require!(self.agents.get(&caller).is_none(), "agent already registered");
        self.agents.insert(&caller, &AgentRecord::new(caller.clone(), now()));
        emit("agent_registered", json!({ "agent_id": caller }));
    }

    pub fn accept_job(&mut self, job_id: u64) {
        let caller = env::predecessor_account_id();
        let mut j = self.job(job_id);
        let mut a = self.agents.get(&caller).unwrap_or_else(|| env::panic_str("caller is not a registered agent"));
        require!(j.status == JobStatus::Open, "job is not open");
        require!(now() < j.deadline_ms, "job deadline has passed");
        require!(j.client_id != caller, "an agent cannot accept its own job");
        if let Err(reason) = can_accept(
            a.bond,
            a.pool_total(),
            a.open_exposure,
            j.value,
            self.config.min_bond.0,
            self.config.max_leverage,
        ) {
            env::panic_str(reason);
        }
        let premium = self.price(&a).0;
        j.premium_bps = Some(premium);
        j.agent_id = Some(caller.clone());
        j.status = JobStatus::Accepted;
        a.open_exposure += j.value;
        self.jobs.replace(job_id, &j);
        self.agents.insert(&caller, &a);
        emit("job_accepted", json!({ "job_id": job_id, "agent_id": caller, "premium_bps": premium, "value": U128(j.value) }));
    }

    pub fn deliver(&mut self, job_id: u64, patch_url: String, patch_hash: String) {
        let caller = env::predecessor_account_id();
        let mut j = self.job(job_id);
        require!(j.status == JobStatus::Accepted, "job is not accepted");
        require!(j.agent_id.as_ref() == Some(&caller), "only the assigned agent can deliver");
        require!(now() < j.deadline_ms, "job deadline has passed");
        require!(!patch_url.is_empty(), "patch_url is required");
        require!(is_sha256_hex(&patch_hash), "patch_hash must be 64 lowercase hex characters");
        j.patch_url = Some(patch_url);
        j.patch_hash = Some(patch_hash.clone());
        j.status = JobStatus::Delivered;
        self.jobs.replace(job_id, &j);
        emit("job_delivered", json!({ "job_id": job_id, "agent_id": caller, "patch_hash": patch_hash }));
    }

    pub fn submit_verdict(
        &mut self,
        job_id: u64,
        score_bps: u32,
        checks_passed: u32,
        checks_total: u32,
        receipts_hash: String,
    ) {
        require!(env::predecessor_account_id() == self.judge_id, "only the judge can submit verdicts");
        let mut j = self.job(job_id);
        require!(j.status == JobStatus::Delivered, "job is not delivered");
        require!(is_sha256_hex(&receipts_hash), "receipts_hash must be 64 lowercase hex characters");
        let expected = score_from_counts(checks_passed, checks_total).unwrap_or_else(|| env::panic_str("bad check counts"));
        require!(expected == score_bps, "score_bps does not match checks_passed / checks_total");
        let t = now();
        j.verdict = Some(Verdict {
            score_bps,
            checks_passed,
            checks_total,
            receipts_hash: receipts_hash.clone(),
            judged_ms: t,
            appeal_deadline_ms: t + self.config.appeal_window_ms,
        });
        j.status = JobStatus::Judged;
        self.jobs.replace(job_id, &j);
        emit("verdict_submitted", json!({ "job_id": job_id, "agent_id": j.agent_id, "score_bps": score_bps, "receipts_hash": receipts_hash }));
    }

    /// Panel sets the final score. The deposit goes back to the appellant if the
    /// score moved in their favour, otherwise to the other party (MECHANISM 6).
    pub fn resolve_appeal(&mut self, job_id: u64, score_bps: u32) {
        require!(env::predecessor_account_id() == self.panel_id, "only the appeal panel can resolve appeals");
        require!(score_bps <= 10_000, "score_bps must be 0..10000");
        let mut j = self.job(job_id);
        require!(j.status == JobStatus::Appealed, "job is not under appeal");
        let mut appeal = j.appeal.clone().unwrap();
        let mut verdict = j.verdict.clone().unwrap();
        let by_client = appeal.appellant_id == j.client_id;
        let favoured = if by_client {
            score_bps < appeal.original_score_bps
        } else {
            score_bps > appeal.original_score_bps
        };
        let other = if by_client { j.agent_id.clone().unwrap() } else { j.client_id.clone() };
        let deposit_to = if favoured { appeal.appellant_id.clone() } else { other };
        appeal.resolved = true;
        verdict.score_bps = score_bps;
        verdict.appeal_deadline_ms = now();
        let deposit = appeal.deposit;
        j.appeal = Some(appeal);
        j.verdict = Some(verdict);
        j.status = JobStatus::Judged;
        self.jobs.replace(job_id, &j);
        emit("appeal_resolved", json!({ "job_id": job_id, "score_bps": score_bps, "deposit_to": deposit_to, "deposit": U128(deposit) }));
        self.pay(&deposit_to, deposit);
    }

    /// Anyone can settle a judged job once its appeal window is over.
    pub fn settle(&mut self, job_id: u64) {
        let j = self.job(job_id);
        require!(j.status == JobStatus::Judged && j.verdict.is_some(), "job is not ready to settle");
        let v = j.verdict.clone().unwrap();
        require!(now() >= v.appeal_deadline_ms, "appeal window still open");
        self.settle_with_score(j, v.score_bps);
    }

    /// Client only. Open: refund. Accepted past its deadline: settle as score 0.
    pub fn cancel_expired(&mut self, job_id: u64) {
        let caller = env::predecessor_account_id();
        let mut j = self.job(job_id);
        require!(caller == j.client_id, "only the client can cancel");
        match j.status {
            JobStatus::Open => {
                j.status = JobStatus::Cancelled;
                self.jobs.replace(job_id, &j);
                emit("job_cancelled", json!({ "job_id": job_id, "client_id": caller, "refund": U128(j.value) }));
                self.pay(&caller, j.value);
            }
            JobStatus::Accepted if now() >= j.deadline_ms => self.settle_with_score(j, 0),
            _ => env::panic_str("job cannot be cancelled now"),
        }
    }

    pub fn withdraw_bond(&mut self, amount: U128) {
        let caller = env::predecessor_account_id();
        let mut a = self.agents.get(&caller).unwrap_or_else(|| env::panic_str("caller is not a registered agent"));
        let v = amount.0;
        require!(v > 0 && v <= a.bond, "bad withdrawal amount");
        self.withdraw_lock(&a);
        let left = a.bond - v;
        require!(left == 0 || left >= self.config.min_bond.0, "bond must stay 0 or at least min_bond");
        a.bond = left;
        self.agents.insert(&caller, &a);
        emit("withdrawn", json!({ "agent_id": caller, "kind": "bond", "amount": amount }));
        self.pay(&caller, v);
    }

    pub fn withdraw_pool(&mut self, agent_id: AccountId, amount: U128) {
        let caller = env::predecessor_account_id();
        let mut a = self.agents.get(&agent_id).unwrap_or_else(|| env::panic_str("unknown agent"));
        let v = amount.0;
        let idx = a
            .backers
            .iter()
            .position(|b| b.backer_id == caller)
            .unwrap_or_else(|| env::panic_str("caller has no stake in this pool"));
        require!(v > 0 && v <= a.backers[idx].amount, "bad withdrawal amount");
        self.withdraw_lock(&a);
        a.backers[idx].amount -= v;
        if a.backers[idx].amount == 0 {
            a.backers.remove(idx);
        }
        self.agents.insert(&agent_id, &a);
        emit("withdrawn", json!({ "agent_id": agent_id, "backer_id": caller, "kind": "pool", "amount": amount }));
        self.pay(&caller, v);
    }

    /// Pull payouts whose ft_transfer failed (for example, receiver not registered on the token).
    pub fn claim(&mut self) {
        let caller = env::predecessor_account_id();
        let v = self.claimable.get(&caller).unwrap_or(0);
        require!(v > 0, "nothing to claim");
        self.claimable.remove(&caller);
        emit("withdrawn", json!({ "account_id": caller, "kind": "claim", "amount": U128(v) }));
        self.pay(&caller, v);
    }

    /// Callback after each ft_transfer. On failure the amount becomes claimable.
    #[private]
    pub fn on_payout(&mut self, receiver_id: AccountId, amount: U128) {
        let ok = env::promise_results_count() == 1 && env::promise_result_checked(0, 1024).is_ok();
        if !ok {
            let v = self.claimable.get(&receiver_id).unwrap_or(0) + amount.0;
            self.claimable.insert(&receiver_id, &v);
            emit("payout_failed", json!({ "account_id": receiver_id, "amount": amount }));
        }
    }

    // ---------- views (SPEC 4.4) ----------

    pub fn get_config(&self) -> Config {
        self.config.clone()
    }

    pub fn get_agent(&self, agent_id: AccountId) -> Option<AgentView> {
        self.agents.get(&agent_id).map(|a| self.agent_view(&a))
    }

    pub fn list_agents(&self, from_index: u64, limit: u64) -> Vec<AgentView> {
        self.agents
            .values()
            .skip(from_index as usize)
            .take(limit as usize)
            .map(|a| self.agent_view(&a))
            .collect()
    }

    pub fn get_job(&self, job_id: u64) -> Option<JobView> {
        self.jobs.get(job_id).map(|j| JobView::from(&j))
    }

    /// Newest first.
    pub fn list_jobs(&self, from_index: u64, limit: u64) -> Vec<JobView> {
        let n = self.jobs.len();
        (0..n)
            .rev()
            .skip(from_index as usize)
            .take(limit as usize)
            .map(|i| JobView::from(&self.jobs.get(i).unwrap()))
            .collect()
    }

    /// Oldest first (the judge polls "Delivered").
    pub fn list_jobs_by_status(&self, status: String, limit: u64) -> Vec<JobView> {
        let s = JobStatus::parse(&status).unwrap_or_else(|| env::panic_str("unknown status"));
        self.jobs
            .iter()
            .filter(|j| j.status == s)
            .take(limit as usize)
            .map(|j| JobView::from(&j))
            .collect()
    }

    pub fn get_price(&self, agent_id: AccountId) -> serde_json::Value {
        let a = self.agents.get(&agent_id).unwrap_or_else(|| env::panic_str("unknown agent"));
        let (premium, failure) = self.price(&a);
        json!({ "premium_bps": premium, "failure_rate_bps": failure })
    }

    pub fn get_claimable(&self, account_id: AccountId) -> U128 {
        U128(self.claimable.get(&account_id).unwrap_or(0))
    }

    pub fn get_roles(&self) -> serde_json::Value {
        json!({ "token_id": self.token_id, "judge_id": self.judge_id, "panel_id": self.panel_id })
    }
}

impl SuretyCore {
    fn job(&self, job_id: u64) -> Job {
        self.jobs.get(job_id).unwrap_or_else(|| env::panic_str("unknown job"))
    }

    /// (premium_bps, failure_rate_bps) at the agent's current record.
    fn price(&self, a: &AgentRecord) -> (u32, u32) {
        let failure = failure_rate_bps(a.weighted_failures, a.weighted_jobs, self.config.reference_value.0);
        let c = &self.config;
        (premium_bps(failure, c.base_fee_bps, c.loading_milli, c.penalty_bps), failure)
    }

    fn agent_view(&self, a: &AgentRecord) -> AgentView {
        let (premium, failure) = self.price(a);
        AgentView {
            agent_id: a.agent_id.clone(),
            bond: U128(a.bond),
            pool_total: U128(a.pool_total()),
            backers: a.backers.iter().map(|b| BackerView { backer_id: b.backer_id.clone(), amount: U128(b.amount) }).collect(),
            open_exposure: U128(a.open_exposure),
            weighted_jobs: U128(a.weighted_jobs),
            weighted_failures: U128(a.weighted_failures),
            failure_rate_bps: failure,
            premium_bps: premium,
            jobs_passed: a.jobs_passed,
            jobs_partial: a.jobs_partial,
            jobs_failed: a.jobs_failed,
            registered_ms: a.registered_ms,
        }
    }

    fn withdraw_lock(&self, a: &AgentRecord) {
        require!(a.open_exposure == 0, "withdrawals are locked while the agent has open jobs");
        require!(
            a.last_settled_ms == 0 || now() >= a.last_settled_ms + self.config.withdraw_cooldown_ms,
            "withdrawal cooldown has not passed"
        );
    }

    fn settle_with_score(&mut self, mut j: Job, score: u32) {
        let agent_id = j.agent_id.clone().unwrap();
        let mut a = self.agents.get(&agent_id).unwrap();
        let r = settle_math(&SettleInput {
            value: j.value,
            score_bps: score,
            min_score_bps: j.min_score_bps,
            premium_bps: j.premium_bps.unwrap_or(0),
            bond: a.bond,
            pool_total: a.pool_total(),
            has_backers: a.has_backers(),
            penalty_bps: self.config.penalty_bps,
            client_share_bps: self.config.client_share_bps,
        });
        // Money: the escrowed value plus any penalty leaves the contract as payouts;
        // premiums and the backers' share of penalties stay inside, in the pool or bond.
        a.bond = a.bond - r.from_bond + r.to_bond;
        apply_pool_loss(&mut a.backers, r.from_pool);
        apply_pool_gain(&mut a.backers, r.to_pool);
        a.backers.retain(|b| b.amount > 0);
        // Record.
        let key = format!("{}|{}", agent_id, j.client_id);
        let k = self.pair_counts.get(&key).unwrap_or(0) + 1;
        self.pair_counts.insert(&key, &k);
        let (wf, wj) = update_record(a.weighted_failures, a.weighted_jobs, job_weight(j.value, k), score);
        a.weighted_failures = wf;
        a.weighted_jobs = wj;
        match r.outcome {
            Outcome::Pass => a.jobs_passed += 1,
            Outcome::Partial => a.jobs_partial += 1,
            Outcome::Fail => a.jobs_failed += 1,
        }
        a.open_exposure -= j.value;
        a.last_settled_ms = now();
        let s = Settlement {
            outcome: r.outcome,
            to_agent: U128(r.to_agent),
            to_client: U128(r.to_client),
            to_pool: U128(r.to_pool + r.to_bond),
            from_bond: U128(r.from_bond),
            from_pool: U128(r.from_pool),
            settled_ms: now(),
        };
        j.status = JobStatus::Settled;
        j.settlement = Some(s.clone());
        self.agents.insert(&agent_id, &a);
        self.jobs.replace(j.job_id, &j);
        emit(
            "job_settled",
            json!({
                "job_id": j.job_id, "agent_id": agent_id, "client_id": j.client_id,
                "outcome": s.outcome, "to_agent": s.to_agent, "to_client": s.to_client, "to_pool": s.to_pool,
                "from_bond": s.from_bond, "from_pool": s.from_pool, "settled_ms": s.settled_ms,
            }),
        );
        self.pay(&agent_id, r.to_agent);
        self.pay(&j.client_id, r.to_client);
    }

    /// ft_transfer with a callback that moves the amount to `claimable` on failure.
    fn pay(&self, to: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        // Detached promise: scheduled when dropped, runs after this call commits.
        let _ = ext_ft::ext(self.token_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(to.clone(), U128(amount), None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_PAYOUT)
                    .on_payout(to.clone(), U128(amount)),
            );
    }
}

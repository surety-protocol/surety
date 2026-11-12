//! Unit tests.
//!
//! 1. Every case in the shared `shared/test-vectors.json` (the same file the
//!    TypeScript tests use), so Rust and TypeScript agree on every number.
//! 2. Contract flows ported from `shared/test/mock-chain.test.ts`.

use near_sdk::{
    json_types::U128,
    serde_json::{self, Value},
    test_utils::{get_logs, VMContextBuilder},
    testing_env, AccountId, NearToken,
};
use std::panic::{catch_unwind, AssertUnwindSafe};

use crate::job::JobStatus;
use crate::pricing::*;
use crate::{Config, SuretyCore};

// ---------------------------------------------------------------------------
// 1. Shared vectors
// ---------------------------------------------------------------------------

fn vectors() -> Value {
    serde_json::from_str(include_str!("../../shared/test-vectors.json")).unwrap()
}
fn n(v: &Value) -> u128 {
    match v {
        Value::String(s) => s.parse().unwrap(),
        Value::Number(x) => x.as_u64().unwrap() as u128,
        _ => panic!("not a number: {v}"),
    }
}
fn u(v: &Value) -> u32 {
    v.as_u64().unwrap() as u32
}

#[test]
fn vectors_config_matches_default() {
    let c = &vectors()["config"];
    let d = Config::default();
    assert_eq!(n(&c["reference_value"]), d.reference_value.0);
    assert_eq!(u(&c["penalty_bps"]), d.penalty_bps);
    assert_eq!(u(&c["client_share_bps"]), d.client_share_bps);
    assert_eq!(u(&c["max_leverage"]), d.max_leverage);
    assert_eq!(u(&c["base_fee_bps"]), d.base_fee_bps);
    assert_eq!(u(&c["loading_milli"]), d.loading_milli);
    assert_eq!(n(&c["min_bond"]), d.min_bond.0);
}

#[test]
fn vectors_failure_rate() {
    let v = vectors();
    let r = n(&v["config"]["reference_value"]);
    for case in v["failure_rate"].as_array().unwrap() {
        let got = failure_rate_bps(n(&case["weighted_failures"]), n(&case["weighted_jobs"]), r);
        assert_eq!(got, u(&case["expected_bps"]), "{}", case["name"]);
    }
}

#[test]
fn vectors_premium() {
    let d = Config::default();
    for case in vectors()["premium"].as_array().unwrap() {
        let got = premium_bps(u(&case["failure_rate_bps"]), d.base_fee_bps, d.loading_milli, d.penalty_bps);
        assert_eq!(got, u(&case["expected_bps"]), "fr {}", case["failure_rate_bps"]);
    }
}

#[test]
fn vectors_job_weight() {
    for case in vectors()["job_weight"].as_array().unwrap() {
        assert_eq!(job_weight(n(&case["value"]), case["k"].as_u64().unwrap()), n(&case["expected"]));
    }
}

#[test]
fn vectors_record_update() {
    for case in vectors()["record_update"].as_array().unwrap() {
        let (wf, wj) = update_record(
            n(&case["weighted_failures"]),
            n(&case["weighted_jobs"]),
            n(&case["weight"]),
            u(&case["score_bps"]),
        );
        assert_eq!(wf, n(&case["expected_failures"]), "{}", case["name"]);
        assert_eq!(wj, n(&case["expected_jobs"]), "{}", case["name"]);
    }
}

#[test]
fn vectors_settle() {
    let v = vectors();
    let c = &v["config"];
    for case in v["settle"].as_array().unwrap() {
        let r = settle(&SettleInput {
            value: n(&case["value"]),
            score_bps: u(&case["score_bps"]),
            min_score_bps: u(&case["min_score_bps"]),
            premium_bps: u(&case["premium_bps"]),
            bond: n(&case["bond"]),
            pool_total: n(&case["pool_total"]),
            has_backers: case["has_backers"].as_bool().unwrap(),
            penalty_bps: u(&c["penalty_bps"]),
            client_share_bps: u(&c["client_share_bps"]),
        });
        let e = &case["expected"];
        let name = case["name"].as_str().unwrap();
        assert_eq!(serde_json::to_value(r.outcome).unwrap(), e["outcome"], "{name}");
        assert_eq!(r.to_agent, n(&e["to_agent"]), "{name} to_agent");
        assert_eq!(r.to_client, n(&e["to_client"]), "{name} to_client");
        assert_eq!(r.to_pool, n(&e["to_pool"]), "{name} to_pool");
        assert_eq!(r.to_bond, n(&e["to_bond"]), "{name} to_bond");
        assert_eq!(r.from_bond, n(&e["from_bond"]), "{name} from_bond");
        assert_eq!(r.from_pool, n(&e["from_pool"]), "{name} from_pool");
        // Conservation.
        assert_eq!(
            n(&case["value"]) + r.from_bond + r.from_pool,
            r.to_agent + r.to_client + r.to_pool + r.to_bond,
            "{name} conserves tokens"
        );
    }
}

#[test]
fn vectors_can_accept() {
    let v = vectors();
    let c = &v["config"];
    for case in v["can_accept"].as_array().unwrap() {
        let ok = can_accept(
            n(&case["bond"]),
            n(&case["pool_total"]),
            n(&case["open_exposure"]),
            n(&case["value"]),
            n(&c["min_bond"]),
            u(&c["max_leverage"]),
        )
        .is_ok();
        assert_eq!(ok, case["expected"].as_bool().unwrap(), "{}", case["name"]);
    }
}

#[test]
fn vectors_pool_delta() {
    for case in vectors()["pool_delta"].as_array().unwrap() {
        let mut backers: Vec<Backer> = case["backers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| Backer { backer_id: format!("{}.near", b[0].as_str().unwrap()).parse().unwrap(), amount: n(&b[1]) })
            .collect();
        let delta: i128 = case["delta"].as_str().unwrap().parse().unwrap();
        if delta >= 0 {
            apply_pool_gain(&mut backers, delta as u128);
        } else {
            apply_pool_loss(&mut backers, (-delta) as u128);
        }
        let got: Vec<u128> = backers.iter().map(|b| b.amount).collect();
        let want: Vec<u128> = case["expected"].as_array().unwrap().iter().map(|e| n(&e[1])).collect();
        assert_eq!(got, want, "{}", case["name"]);
    }
}

#[test]
fn vectors_collusion_safe() {
    for case in vectors()["collusion_safe"].as_array().unwrap() {
        assert_eq!(
            is_collusion_safe(u(&case["max_leverage"]), u(&case["penalty_bps"]), u(&case["client_share_bps"])),
            case["expected"].as_bool().unwrap()
        );
    }
}

// ---------------------------------------------------------------------------
// 2. Contract flows
// ---------------------------------------------------------------------------

const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH2: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const T: u128 = 1_000_000; // 1 tUSDC
const START_MS: u64 = 1_800_000_000_000;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

struct Harness {
    c: SuretyCore,
    now_ms: u64,
}

impl Harness {
    fn new() -> Self {
        Self::with_config(Config::default())
    }
    fn with_config(config: Config) -> Self {
        let mut h = Harness { c: unsafe_init(), now_ms: START_MS };
        h.ctx("owner.near");
        h.c = SuretyCore::new(acc("tusdc.near"), acc("judge.near"), acc("panel.near"), Some(config));
        h
    }
    fn ctx(&self, who: &str) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(acc("core.near"))
            .predecessor_account_id(acc(who))
            .block_timestamp(self.now_ms * 1_000_000)
            .attached_deposit(NearToken::from_yoctonear(0))
            .build());
    }
    fn advance(&mut self, ms: u64) {
        self.now_ms += ms;
    }
    /// ft_transfer_call from `who` with this msg.
    fn transfer(&mut self, who: &str, amount: u128, msg: Value) {
        self.ctx("tusdc.near");
        let _ = self.c.ft_on_transfer(acc(who), U128(amount), msg.to_string());
    }
    fn agent(&mut self, id: &str, bond: u128) {
        self.ctx(id);
        self.c.register_agent();
        self.transfer(id, bond * T, serde_json::json!({ "action": "bond" }));
    }
    fn post(&mut self, client: &str, value: u128, deadline_in_ms: u64) -> u64 {
        let deadline = self.now_ms + deadline_in_ms;
        self.transfer(
            client,
            value * T,
            serde_json::json!({ "action": "post_job", "spec_hash": HASH, "spec_url": "agents/jobs/x.json", "deadline_ms": deadline }),
        );
        self.c.jobs.len() - 1
    }
    fn judged(&mut self, client: &str, agent: &str, value: u128, passed: u32, total: u32) -> u64 {
        let id = self.post(client, value, 3_600_000);
        self.ctx(agent);
        self.c.accept_job(id);
        self.c.deliver(id, "agents/patches/x.diff".into(), HASH2.into());
        self.ctx("judge.near");
        self.c.submit_verdict(id, score_from_counts(passed, total).unwrap(), passed, total, HASH.into());
        id
    }
    fn run(&mut self, client: &str, agent: &str, value: u128, passed: u32, total: u32) -> u64 {
        let id = self.judged(client, agent, value, passed, total);
        self.advance(self.c.config.appeal_window_ms);
        self.ctx("anyone.near");
        self.c.settle(id);
        id
    }
    fn job(&self, id: u64) -> Value {
        serde_json::to_value(self.c.get_job(id).unwrap()).unwrap()
    }
    fn agent_view(&self, id: &str) -> Value {
        serde_json::to_value(self.c.get_agent(acc(id)).unwrap()).unwrap()
    }
    /// Run `f` as `who` and return its panic message, or None if it succeeded.
    fn fails(&mut self, who: &str, f: impl FnOnce(&mut SuretyCore)) -> Option<String> {
        self.ctx(who);
        let c = &mut self.c;
        catch_unwind(AssertUnwindSafe(|| f(c))).err().map(|e| {
            e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default()
        })
    }
}

/// Placeholder before `new` runs inside a context.
fn unsafe_init() -> SuretyCore {
    testing_env!(VMContextBuilder::new().build());
    SuretyCore::new(acc("t.near"), acc("j.near"), acc("p.near"), None)
}

fn events(name: &str) -> Vec<Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|s| serde_json::from_str::<Value>(s).unwrap())
        .filter(|e| e["event"] == name)
        .collect()
}

fn s(v: &Value) -> String {
    v.as_str().unwrap().to_string()
}

#[test]
fn pass_no_backers_premium_to_bond() {
    let mut h = Harness::new();
    h.agent("agent.near", 100);
    let id = h.run("client.near", "agent.near", 50, 7, 7);
    let st = &h.job(id)["settlement"];
    assert_eq!(st["outcome"], "Pass");
    assert_eq!(s(&st["to_agent"]), "46500000");
    assert_eq!(s(&st["to_pool"]), "3500000"); // to_bond reported in to_pool, as MockChain does
    assert_eq!(s(&h.agent_view("agent.near")["bond"]), "103500000");
    assert_eq!(h.job(id)["status"], "Settled");
}

#[test]
fn fail_no_backers_whole_penalty_to_client() {
    let mut h = Harness::new();
    h.agent("agent.near", 100);
    let id = h.run("client.near", "agent.near", 50, 2, 7);
    let st = &h.job(id)["settlement"];
    assert_eq!(st["outcome"], "Fail");
    assert_eq!(s(&st["to_client"]), "60000000");
    assert_eq!(s(&st["from_bond"]), "10000000");
    assert_eq!(s(&h.agent_view("agent.near")["bond"]), "90000000");
}

#[test]
fn fail_with_backers_half_penalty_to_pool_kept_inside() {
    let mut h = Harness::new();
    h.agent("agent.near", 100);
    h.transfer("backer.near", 200 * T, serde_json::json!({ "action": "pool", "agent_id": "agent.near" }));
    let id = h.run("client.near", "agent.near", 50, 2, 7);
    let st = &h.job(id)["settlement"];
    assert_eq!(s(&st["to_client"]), "55000000");
    assert_eq!(s(&st["to_pool"]), "5000000");
    let a = h.agent_view("agent.near");
    assert_eq!(s(&a["pool_total"]), "205000000", "backers' share stays in the pool");
    assert_eq!(s(&a["backers"][0]["amount"]), "205000000");
}

#[test]
fn bond_and_pool_short_pays_only_what_exists() {
    let mut h = Harness::with_config(Config { min_bond: U128(5 * T), ..Config::default() });
    h.agent("agent.near", 5);
    h.transfer("backer.near", 3 * T, serde_json::json!({ "action": "pool", "agent_id": "agent.near" }));
    // Exposure cap = min(bond + pool, 8 x bond) = 8 tUSDC, so use an 8 tUSDC job: penalty 1.6
    let id = h.run("client.near", "agent.near", 8, 0, 1);
    let st = &h.job(id)["settlement"];
    assert_eq!(s(&st["from_bond"]), "1600000");
    assert_eq!(s(&st["from_pool"]), "0");
}

#[test]
fn accept_rules() {
    let mut h = Harness::new();
    h.ctx("small.near");
    h.c.register_agent();
    h.transfer("small.near", 10 * T, serde_json::json!({ "action": "bond" }));
    let id = h.post("client.near", 50, 3_600_000);
    assert!(h.fails("small.near", |c| c.accept_job(id)).unwrap().contains("bond below minimum"));
    h.agent("agent.near", 100);
    let big = h.post("client.near", 150, 3_600_000);
    assert!(h.fails("agent.near", |c| c.accept_job(big)).unwrap().contains("coverage"));
    let own = h.post("agent.near", 50, 3_600_000);
    assert!(h.fails("agent.near", |c| c.accept_job(own)).unwrap().contains("own job"));
    assert!(h.fails("client.near", |c| c.accept_job(id)).unwrap().contains("not a registered agent"));
}

#[test]
fn verdict_rules() {
    let mut h = Harness::new();
    h.agent("agent.near", 100);
    let id = h.post("client.near", 50, 3_600_000);
    h.ctx("agent.near");
    h.c.accept_job(id);
    assert!(h.fails("judge.near", |c| c.submit_verdict(id, 10000, 1, 1, HASH.into())).unwrap().contains("not delivered"));
    h.ctx("agent.near");
    h.c.deliver(id, "p".into(), HASH2.into());
    assert!(h.fails("agent.near", |c| c.submit_verdict(id, 10000, 1, 1, HASH.into())).unwrap().contains("only the judge"));
    assert!(h.fails("judge.near", |c| c.submit_verdict(id, 9000, 1, 1, HASH.into())).unwrap().contains("does not match"));
    assert!(h.fails("judge.near", |c| c.submit_verdict(id, 0, 0, 0, HASH.into())).unwrap().contains("bad check counts"));
    assert!(h.fails("judge.near", |c| c.submit_verdict(id, 10000, 1, 1, "x".into())).unwrap().contains("receipts_hash"));
    h.ctx("judge.near");
    h.c.submit_verdict(id, 7142, 5, 7, HASH.into());
    assert!(h.fails("judge.near", |c| c.submit_verdict(id, 7142, 5, 7, HASH.into())).unwrap().contains("not delivered"));
    let v = &h.job(id)["verdict"];
    assert_eq!(v["score_bps"], 7142);
    assert_eq!(v["judged_ms"], START_MS);
    assert_eq!(v["appeal_deadline_ms"], START_MS + 120_000);
    assert!(h.fails("x.near", |c| c.settle(id)).unwrap().contains("appeal window still open"));
}

#[test]
fn appeal_by_agent_that_wins_refunds_deposit_and_uses_new_score() {
    let mut h = Harness::new();
    h.agent("agent.near", 100);
    let id = h.judged("client.near", "agent.near", 50, 2, 7);
    let deposit = h.c.config.appeal_deposit.0;
    let appeal = |h: &mut Harness, who: &str| {
        let msg = serde_json::json!({ "action": "appeal", "job_id": id }).to_string();
        h.fails("tusdc.near", |c| {
            let _ = c.ft_on_transfer(acc(who), U128(deposit), msg);
        })
    };
    assert!(appeal(&mut h, "backer.near").unwrap().contains("only the client or the agent"));
    assert!(appeal(&mut h, "agent.near").is_none());
    assert!(appeal(&mut h, "client.near").unwrap().contains("only a judged job"));
    let j = h.job(id);
    assert_eq!(j["status"], "Appealed");
    assert_eq!(j["appeal"]["original_score_bps"], 2857);
    assert_eq!(j["verdict"]["score_bps"], 2857, "verdict is kept during the appeal");
    assert!(h.fails("judge.near", |c| c.submit_verdict(id, 10000, 7, 7, HASH.into())).unwrap().contains("not delivered"));
    assert!(h.fails("agent.near", |c| c.resolve_appeal(id, 10000)).unwrap().contains("only the appeal panel"));
    h.ctx("panel.near");
    h.c.resolve_appeal(id, 10000);
    let e = events("appeal_resolved");
    assert_eq!(e[0]["data"][0]["deposit_to"], "agent.near");
    h.ctx("x.near");
    h.c.settle(id); // window closed by the panel
    assert_eq!(h.job(id)["settlement"]["outcome"], "Pass");
}

#[test]
fn appeal_by_client_that_loses_pays_the_agent() {
    let mut h = Harness::new();
    h.agent("agent.near", 100);
    let id = h.judged("client.near", "agent.near", 50, 7, 7);
    h.transfer("client.near", 5 * T, serde_json::json!({ "action": "appeal", "job_id": id }));
    h.ctx("panel.near");
    h.c.resolve_appeal(id, 10000);
    assert_eq!(events("appeal_resolved")[0]["data"][0]["deposit_to"], "agent.near");
}

#[test]
fn appeal_window_closes_and_deposit_must_match() {
    let mut h = Harness::new();
    h.agent("agent.near", 100);
    let id = h.judged("client.near", "agent.near", 50, 0, 7);
    let msg = serde_json::json!({ "action": "appeal", "job_id": id }).to_string();
    let m2 = msg.clone();
    assert!(h.fails("tusdc.near", |c| { let _ = c.ft_on_transfer(acc("agent.near"), U128(T), m2); }).unwrap().contains("appeal deposit"));
    h.advance(120_000);
    assert!(h.fails("tusdc.near", |c| { let _ = c.ft_on_transfer(acc("agent.near"), U128(5 * T), msg); }).unwrap().contains("window closed"));
}

#[test]
fn cancel_open_refunds_and_missed_deadline_fails() {
    let mut h = Harness::new();
    h.agent("agent.near", 100);
    let open = h.post("client.near", 50, 1000);
    assert!(h.fails("agent.near", |c| c.cancel_expired(open)).unwrap().contains("only the client"));
    h.ctx("client.near");
    h.c.cancel_expired(open);
    assert_eq!(h.job(open)["status"], "Cancelled");
    let late = h.post("client.near", 50, 1000);
    h.ctx("agent.near");
    h.c.accept_job(late);
    assert!(h.fails("client.near", |c| c.cancel_expired(late)).unwrap().contains("cannot be cancelled now"));
    h.advance(1000);
    assert!(h.fails("agent.near", |c| c.deliver(late, "p".into(), HASH2.into())).unwrap().contains("deadline"));
    h.ctx("client.near");
    h.c.cancel_expired(late);
    assert_eq!(h.job(late)["status"], "Settled");
    assert_eq!(h.job(late)["settlement"]["outcome"], "Fail");
}

#[test]
fn withdrawals_locked_cooldown_and_min_bond() {
    let mut h = Harness::new();
    h.agent("agent.near", 300);
    h.transfer("backer.near", 100 * T, serde_json::json!({ "action": "pool", "agent_id": "agent.near" }));
    let id = h.post("client.near", 50, 3_600_000);
    h.ctx("agent.near");
    h.c.accept_job(id);
    assert!(h.fails("agent.near", |c| c.withdraw_bond(U128(10 * T))).unwrap().contains("locked"));
    assert!(h.fails("backer.near", |c| c.withdraw_pool(acc("agent.near"), U128(10 * T))).unwrap().contains("locked"));
    h.ctx("agent.near");
    h.c.deliver(id, "p".into(), HASH2.into());
    h.ctx("judge.near");
    h.c.submit_verdict(id, 10000, 1, 1, HASH.into());
    h.advance(120_000);
    h.ctx("x.near");
    h.c.settle(id);
    assert!(h.fails("agent.near", |c| c.withdraw_bond(U128(10 * T))).unwrap().contains("cooldown"));
    h.advance(60_000);
    assert!(h.fails("agent.near", |c| c.withdraw_bond(U128(250 * T))).unwrap().contains("min_bond"));
    h.ctx("agent.near");
    h.c.withdraw_bond(U128(150 * T));
    h.ctx("backer.near");
    h.c.withdraw_pool(acc("agent.near"), U128(50 * T));
    assert!(h.fails("fake.near", |c| c.withdraw_pool(acc("agent.near"), U128(1))).unwrap().contains("no stake"));
}

#[test]
fn deposits_and_bad_msgs() {
    let mut h = Harness::new();
    assert!(h.fails("tusdc.near", |c| { let _ = c.ft_on_transfer(acc("client.near"), U128(T), r#"{"action":"bond"}"#.into()); }).unwrap().contains("registered agent"));
    h.ctx("agent.near");
    h.c.register_agent();
    assert!(h.fails("agent.near", |c| c.register_agent()).unwrap().contains("already registered"));
    assert!(h.fails("tusdc.near", |c| { let _ = c.ft_on_transfer(acc("agent.near"), U128(T), r#"{"action":"pool","agent_id":"agent.near"}"#.into()); }).unwrap().contains("cannot back itself"));
    assert!(h.fails("tusdc.near", |c| { let _ = c.ft_on_transfer(acc("x.near"), U128(T), r#"{"action":"steal"}"#.into()); }).unwrap().contains("unknown msg"));
    assert!(h.fails("evil.near", |c| { let _ = c.ft_on_transfer(acc("x.near"), U128(T), r#"{"action":"bond"}"#.into()); }).unwrap().contains("only the tUSDC token"));
    let bad = format!(r#"{{"action":"post_job","spec_hash":"xyz","spec_url":"x","deadline_ms":{}}}"#, START_MS + 10);
    assert!(h.fails("tusdc.near", |c| { let _ = c.ft_on_transfer(acc("client.near"), U128(T), bad); }).unwrap().contains("spec_hash"));
    let past = format!(r#"{{"action":"post_job","spec_hash":"{HASH}","spec_url":"x","deadline_ms":{}}}"#, START_MS - 1);
    assert!(h.fails("tusdc.near", |c| { let _ = c.ft_on_transfer(acc("client.near"), U128(T), past); }).unwrap().contains("future"));
}

#[test]
fn unsafe_config_rejected() {
    let r = catch_unwind(|| Harness::with_config(Config { max_leverage: 10, ..Config::default() }));
    assert!(r.is_err());
}

#[test]
fn repeat_client_counts_value_over_k() {
    let mut h = Harness::new();
    h.agent("agent.near", 300);
    for _ in 0..3 {
        h.run("fake.near", "agent.near", 50, 1, 1);
    }
    // 50 + 25 + 16.666666
    assert_eq!(s(&h.agent_view("agent.near")["weighted_jobs"]), "91666666");
}

#[test]
fn colluding_pair_loses_money_even_when_draining_the_pool() {
    let mut h = Harness::with_config(Config { min_bond: U128(10 * T), ..Config::default() });
    h.agent("agent.near", 100);
    h.transfer("backer.near", 5000 * T, serde_json::json!({ "action": "pool", "agent_id": "agent.near" }));
    let mut ids = vec![];
    for _ in 0..8 {
        let id = h.post("partner.near", 100, 3_600_000);
        h.ctx("agent.near");
        h.c.accept_job(id);
        ids.push(id);
    }
    for &id in &ids {
        h.ctx("agent.near");
        h.c.deliver(id, "p".into(), HASH2.into());
        h.ctx("judge.near");
        h.c.submit_verdict(id, 0, 0, 1, HASH.into());
    }
    h.advance(120_000);
    let mut partner_gain: i128 = 0;
    for &id in &ids {
        h.ctx("x.near");
        h.c.settle(id);
        let st = &h.job(id)["settlement"];
        partner_gain += n(&st["to_client"]) as i128 - 100 * T as i128;
    }
    let bond_lost = 100 * T as i128 - n(&h.agent_view("agent.near")["bond"]) as i128;
    assert!(partner_gain - bond_lost < 0, "pair must lose: partner +{partner_gain}, bond -{bond_lost}");
}

#[test]
fn views_and_events_match_spec_shapes() {
    let mut h = Harness::new();
    h.agent("agent.near", 100);
    h.transfer("backer.near", 50 * T, serde_json::json!({ "action": "pool", "agent_id": "agent.near" }));
    let id = h.run("client.near", "agent.near", 50, 7, 7);
    let j = h.job(id);
    for key in [
        "job_id", "client_id", "value", "spec_hash", "spec_url", "min_score_bps", "deadline_ms", "posted_ms", "status",
        "agent_id", "premium_bps", "patch_url", "patch_hash", "verdict", "appeal", "settlement",
    ] {
        assert!(j.get(key).is_some(), "JobView missing {key}");
    }
    for key in ["score_bps", "checks_passed", "checks_total", "receipts_hash", "judged_ms", "appeal_deadline_ms"] {
        assert!(j["verdict"].get(key).is_some(), "verdict missing {key}");
    }
    for key in ["outcome", "to_agent", "to_client", "to_pool", "from_bond", "from_pool", "settled_ms"] {
        assert!(j["settlement"].get(key).is_some(), "settlement missing {key}");
    }
    assert!(j["appeal"].is_null());
    let a = h.agent_view("agent.near");
    for key in [
        "agent_id", "bond", "pool_total", "backers", "open_exposure", "weighted_jobs", "weighted_failures",
        "failure_rate_bps", "premium_bps", "jobs_passed", "jobs_partial", "jobs_failed", "registered_ms",
    ] {
        assert!(a.get(key).is_some(), "AgentView missing {key}");
    }
    assert_eq!(a["backers"][0]["backer_id"], "backer.near");
    let e = events("job_settled");
    assert_eq!(e[0]["standard"], "surety");
    assert!(e[0]["data"].is_array());
    assert_eq!(e[0]["data"][0]["job_id"], id);
    assert_eq!(h.c.list_jobs(0, 10)[0].job_id, id);
    assert_eq!(h.c.list_jobs_by_status("Settled".into(), 10).len(), 1);
    assert_eq!(h.c.list_jobs_by_status("Settled".into(), 10)[0].status, JobStatus::Settled);
    let price = h.c.get_price(acc("agent.near"));
    assert!(price.get("premium_bps").is_some() && price.get("failure_rate_bps").is_some());
}

#[test]
fn failed_payout_becomes_claimable() {
    let mut h = Harness::new();
    testing_env!(
        VMContextBuilder::new().current_account_id(acc("core.near")).predecessor_account_id(acc("core.near")).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![near_sdk::PromiseResult::Failed],
    );
    h.c.on_payout(acc("client.near"), U128(7 * T));
    assert_eq!(h.c.get_claimable(acc("client.near")).0, 7 * T);
    h.ctx("client.near");
    h.c.claim();
    assert_eq!(h.c.get_claimable(acc("client.near")).0, 0);
    assert!(h.fails("client.near", |c| c.claim()).unwrap().contains("nothing to claim"));
}

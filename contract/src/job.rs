//! Job state and the JobView shape (docs/SPEC.md section 4.5).
//!
//! Open -> Accepted -> Delivered -> Judged -> Settled
//!                                    Judged -> Appealed -> Judged (window closed) -> Settled
//! Open -> Cancelled (client cancels, refunded)
//! Accepted past deadline -> Settled as a fail (cancel_expired)

use near_sdk::{json_types::U128, near, AccountId};

use crate::pricing::Outcome;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[near(serializers = [borsh, json])]
pub enum JobStatus {
    Open,
    Accepted,
    Delivered,
    Judged,
    Appealed,
    Settled,
    Cancelled,
}

impl JobStatus {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "Open" => Self::Open,
            "Accepted" => Self::Accepted,
            "Delivered" => Self::Delivered,
            "Judged" => Self::Judged,
            "Appealed" => Self::Appealed,
            "Settled" => Self::Settled,
            "Cancelled" => Self::Cancelled,
            _ => return None,
        })
    }
}

#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct Verdict {
    pub score_bps: u32,
    pub checks_passed: u32,
    pub checks_total: u32,
    pub receipts_hash: String,
    pub judged_ms: u64,
    pub appeal_deadline_ms: u64,
}

#[derive(Clone, Debug)]
#[near(serializers = [borsh])]
pub struct Appeal {
    pub appellant_id: AccountId,
    pub deposit: u128,
    pub original_score_bps: u32,
    pub resolved: bool,
}

#[derive(Clone, Debug)]
#[near(serializers = [borsh, json])]
pub struct Settlement {
    pub outcome: Outcome,
    pub to_agent: U128,
    pub to_client: U128,
    /// Premium (pass/partial) or the backers' share of the penalty (fail). With no
    /// backers, the premium added to the agent's bond.
    pub to_pool: U128,
    pub from_bond: U128,
    pub from_pool: U128,
    pub settled_ms: u64,
}

#[derive(Clone)]
#[near(serializers = [borsh])]
pub struct Job {
    pub job_id: u64,
    pub client_id: AccountId,
    pub value: u128,
    pub spec_hash: String,
    pub spec_url: String,
    pub min_score_bps: u32,
    pub deadline_ms: u64,
    pub posted_ms: u64,
    pub status: JobStatus,
    pub agent_id: Option<AccountId>,
    pub premium_bps: Option<u32>,
    pub patch_url: Option<String>,
    pub patch_hash: Option<String>,
    pub verdict: Option<Verdict>,
    pub appeal: Option<Appeal>,
    pub settlement: Option<Settlement>,
}

#[near(serializers = [json])]
pub struct AppealView {
    pub appellant_id: AccountId,
    pub deposit: U128,
    pub original_score_bps: u32,
}

#[near(serializers = [json])]
pub struct JobView {
    pub job_id: u64,
    pub client_id: AccountId,
    pub value: U128,
    pub spec_hash: String,
    pub spec_url: String,
    pub min_score_bps: u32,
    pub deadline_ms: u64,
    pub posted_ms: u64,
    pub status: JobStatus,
    pub agent_id: Option<AccountId>,
    pub premium_bps: Option<u32>,
    pub patch_url: Option<String>,
    pub patch_hash: Option<String>,
    pub verdict: Option<Verdict>,
    pub appeal: Option<AppealView>,
    pub settlement: Option<Settlement>,
}

impl From<&Job> for JobView {
    fn from(j: &Job) -> Self {
        Self {
            job_id: j.job_id,
            client_id: j.client_id.clone(),
            value: U128(j.value),
            spec_hash: j.spec_hash.clone(),
            spec_url: j.spec_url.clone(),
            min_score_bps: j.min_score_bps,
            deadline_ms: j.deadline_ms,
            posted_ms: j.posted_ms,
            status: j.status,
            agent_id: j.agent_id.clone(),
            premium_bps: j.premium_bps,
            patch_url: j.patch_url.clone(),
            patch_hash: j.patch_hash.clone(),
            verdict: j.verdict.clone(),
            appeal: j.appeal.as_ref().map(|a| AppealView {
                appellant_id: a.appellant_id.clone(),
                deposit: U128(a.deposit),
                original_score_bps: a.original_score_bps,
            }),
            settlement: j.settlement.clone(),
        }
    }
}

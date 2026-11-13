//! Agent state and the AgentView shape (docs/SPEC.md section 4.5).

use near_sdk::{json_types::U128, near, AccountId};

use crate::pricing::{pool_total, Backer};

#[derive(Clone)]
#[near(serializers = [borsh])]
pub struct AgentRecord {
    pub agent_id: AccountId,
    pub bond: u128,
    pub backers: Vec<Backer>,
    /// Sum of values of the agent's Accepted, Delivered, Judged and Appealed jobs.
    pub open_exposure: u128,
    /// N_w
    pub weighted_jobs: u128,
    /// F_w
    pub weighted_failures: u128,
    pub jobs_passed: u64,
    pub jobs_partial: u64,
    pub jobs_failed: u64,
    pub registered_ms: u64,
    /// Withdrawals wait `withdraw_cooldown_ms` after the agent's last settlement.
    pub last_settled_ms: u64,
}

impl AgentRecord {
    pub fn new(agent_id: AccountId, now_ms: u64) -> Self {
        Self {
            agent_id,
            bond: 0,
            backers: Vec::new(),
            open_exposure: 0,
            weighted_jobs: 0,
            weighted_failures: 0,
            jobs_passed: 0,
            jobs_partial: 0,
            jobs_failed: 0,
            registered_ms: now_ms,
            last_settled_ms: 0,
        }
    }

    pub fn pool_total(&self) -> u128 {
        pool_total(&self.backers)
    }

    pub fn has_backers(&self) -> bool {
        !self.backers.is_empty() && self.pool_total() > 0
    }
}

#[near(serializers = [json])]
pub struct BackerView {
    pub backer_id: AccountId,
    pub amount: U128,
}

#[near(serializers = [json])]
pub struct AgentView {
    pub agent_id: AccountId,
    pub bond: U128,
    pub pool_total: U128,
    pub backers: Vec<BackerView>,
    pub open_exposure: U128,
    pub weighted_jobs: U128,
    pub weighted_failures: U128,
    pub failure_rate_bps: u32,
    pub premium_bps: u32,
    pub jobs_passed: u64,
    pub jobs_partial: u64,
    pub jobs_failed: u64,
    pub registered_ms: u64,
}

//! Protocol configuration (docs/SPEC.md section 4.1).

use near_sdk::{json_types::U128, near, require};

use crate::pricing::is_collusion_safe;

#[derive(Clone, Debug, PartialEq)]
#[near(serializers = [borsh, json])]
pub struct Config {
    /// Minimum bond to accept jobs. Default 100 tUSDC.
    pub min_bond: U128,
    /// Used by the price prior. Default 50 tUSDC.
    pub reference_value: U128,
    /// Penalty on a fail, share of job value. Default 2000 (20%).
    pub penalty_bps: u32,
    /// Share of the penalty paid to the client; the rest goes to backers. Default 5000.
    pub client_share_bps: u32,
    /// Open exposure <= max_leverage * bond. Default 8.
    pub max_leverage: u32,
    pub base_fee_bps: u32,
    pub loading_milli: u32,
    pub default_min_score_bps: u32,
    pub appeal_window_ms: u64,
    pub appeal_deposit: U128,
    pub withdraw_cooldown_ms: u64,
    pub max_backers_per_agent: u32,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            min_bond: U128(100_000_000),
            reference_value: U128(50_000_000),
            penalty_bps: 2000,
            client_share_bps: 5000,
            max_leverage: 8,
            base_fee_bps: 100,
            loading_milli: 1500,
            default_min_score_bps: 5000,
            appeal_window_ms: 120_000,
            appeal_deposit: U128(5_000_000),
            withdraw_cooldown_ms: 60_000,
            max_backers_per_agent: 20,
        }
    }
}

impl Config {
    /// Panics on a config that breaks the mechanism's assumptions.
    pub fn validate(&self) {
        require!(self.reference_value.0 > 0, "reference_value must be positive");
        require!(self.max_leverage >= 1, "max_leverage must be at least 1");
        require!(self.penalty_bps <= 10_000, "penalty_bps must be 0..10000");
        require!(self.client_share_bps <= 10_000, "client_share_bps must be 0..10000");
        require!(
            (1..=10_000).contains(&self.default_min_score_bps),
            "default_min_score_bps must be 1..10000"
        );
        require!(self.appeal_deposit.0 > 0, "appeal_deposit must be positive");
        require!(
            is_collusion_safe(self.max_leverage, self.penalty_bps, self.client_share_bps),
            "config rejected: max_leverage * penalty_bps * client_share_bps must be < 100000000"
        );
    }
}

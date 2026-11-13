//! MECHANISM.md sections 2-5 as pure functions, mirroring `shared/src/pricing.ts`.
//!
//! Integers only; every division rounds down. These functions must return the
//! same numbers as the TypeScript version for every case in
//! `shared/test-vectors.json` (checked in `tests.rs`).

use near_sdk::{near, AccountId};

pub const BPS: u128 = 10_000;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[near(serializers = [borsh, json])]
pub enum Outcome {
    Pass,
    Partial,
    Fail,
}

/// MECHANISM 5: collusion loses money only while leverage * penalty * client share < 10000^2.
pub fn is_collusion_safe(max_leverage: u32, penalty_bps: u32, client_share_bps: u32) -> bool {
    (max_leverage as u128) * (penalty_bps as u128) * (client_share_bps as u128) < BPS * BPS
}

/// MECHANISM 3.1: the k-th settled job between the same agent and client counts value / k.
pub fn job_weight(value: u128, k: u64) -> u128 {
    assert!(k >= 1, "k must be >= 1");
    value / k as u128
}

/// MECHANISM 3.2 with the 1-in-5 prior.
pub fn failure_rate_bps(weighted_failures: u128, weighted_jobs: u128, reference_value: u128) -> u32 {
    assert!(reference_value > 0, "reference_value must be positive");
    assert!(weighted_failures <= weighted_jobs, "weighted_failures cannot exceed weighted_jobs");
    ((weighted_failures + reference_value) * BPS / (weighted_jobs + 5 * reference_value)) as u32
}

/// MECHANISM 3.3: base fee + loading x failure rate x penalty.
pub fn premium_bps(failure_bps: u32, base_fee_bps: u32, loading_milli: u32, penalty_bps: u32) -> u32 {
    assert!(failure_bps <= 10_000, "failure_bps must be 0..10000");
    let variable = (loading_milli as u128) * (failure_bps as u128) * (penalty_bps as u128) / 10_000_000;
    base_fee_bps + variable as u32
}

/// MECHANISM 3.2: record update after settlement with final score s.
/// Returns (weighted_failures, weighted_jobs).
pub fn update_record(weighted_failures: u128, weighted_jobs: u128, weight: u128, score_bps: u32) -> (u128, u128) {
    assert!(score_bps <= 10_000, "score_bps must be 0..10000");
    (
        weighted_failures + weight * (BPS - score_bps as u128) / BPS,
        weighted_jobs + weight,
    )
}

pub fn outcome_for(score_bps: u32, min_score_bps: u32) -> Outcome {
    if score_bps == 10_000 {
        Outcome::Pass
    } else if score_bps < min_score_bps {
        Outcome::Fail
    } else {
        Outcome::Partial
    }
}

/// Score from check counts: floor(passed * 10000 / total). None on bad counts.
pub fn score_from_counts(passed: u32, total: u32) -> Option<u32> {
    if total == 0 || passed > total {
        return None;
    }
    Some(((passed as u64) * 10_000 / total as u64) as u32)
}

/// MECHANISM 2: may this agent accept a job of this value right now?
pub fn can_accept(
    bond: u128,
    pool_total: u128,
    open_exposure: u128,
    value: u128,
    min_bond: u128,
    max_leverage: u32,
) -> Result<(), &'static str> {
    if bond < min_bond {
        return Err("bond below minimum");
    }
    let after = open_exposure + value;
    if after > bond + pool_total {
        return Err("exposure would exceed coverage (bond + pool)");
    }
    if after > (max_leverage as u128) * bond {
        return Err("exposure would exceed max_leverage x bond");
    }
    Ok(())
}

pub struct SettleInput {
    pub value: u128,
    pub score_bps: u32,
    pub min_score_bps: u32,
    pub premium_bps: u32,
    pub bond: u128,
    pub pool_total: u128,
    /// false = no backers: the premium is added to the agent's bond (MECHANISM 4.1).
    pub has_backers: bool,
    pub penalty_bps: u32,
    pub client_share_bps: u32,
}

#[derive(Debug, PartialEq, Eq)]
pub struct SettleResult {
    pub outcome: Outcome,
    pub to_agent: u128,
    pub to_client: u128,
    /// Added to the backers' pool.
    pub to_pool: u128,
    /// Premium added to the agent's bond when there are no backers.
    pub to_bond: u128,
    pub from_bond: u128,
    pub from_pool: u128,
}

/// MECHANISM 4: who receives what when a job settles. Conserves tokens exactly:
/// value + from_bond + from_pool = to_agent + to_client + to_pool + to_bond.
pub fn settle(i: &SettleInput) -> SettleResult {
    let outcome = outcome_for(i.score_bps, i.min_score_bps);
    if outcome == Outcome::Fail {
        let penalty = i.value * i.penalty_bps as u128 / BPS;
        let from_bond = penalty.min(i.bond);
        let from_pool = (penalty - from_bond).min(i.pool_total);
        let collected = from_bond + from_pool;
        // No backers: nobody receives the backers' share, so the client gets all of it.
        let client_cut = if i.has_backers { collected * i.client_share_bps as u128 / BPS } else { collected };
        return SettleResult {
            outcome,
            to_agent: 0,
            to_client: i.value + client_cut,
            to_pool: collected - client_cut,
            to_bond: 0,
            from_bond,
            from_pool,
        };
    }
    let gross = if outcome == Outcome::Pass { i.value } else { i.value * i.score_bps as u128 / BPS };
    let premium = gross * i.premium_bps as u128 / BPS;
    SettleResult {
        outcome,
        to_agent: gross - premium,
        to_client: i.value - gross,
        to_pool: if i.has_backers { premium } else { 0 },
        to_bond: if i.has_backers { 0 } else { premium },
        from_bond: 0,
        from_pool: 0,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[near(serializers = [borsh])]
pub struct Backer {
    pub backer_id: AccountId,
    pub amount: u128,
}

pub fn pool_total(backers: &[Backer]) -> u128 {
    backers.iter().map(|b| b.amount).sum()
}

/// Indices ordered largest amount first, ties broken by account id.
fn largest_first(backers: &[Backer]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..backers.len()).collect();
    order.sort_by(|&a, &b| {
        backers[b]
            .amount
            .cmp(&backers[a].amount)
            .then_with(|| backers[a].backer_id.as_str().cmp(backers[b].backer_id.as_str()))
    });
    order
}

/// Add a pool gain pro rata. Dust goes to the largest backer (ties by id),
/// so the pool grows by exactly `gain`.
pub fn apply_pool_gain(backers: &mut [Backer], gain: u128) {
    if gain == 0 {
        return;
    }
    let total = pool_total(backers);
    assert!(total > 0, "cannot apply a pool delta to an empty pool");
    let mut applied = 0;
    for b in backers.iter_mut() {
        let share = b.amount * gain / total;
        b.amount += share;
        applied += share;
    }
    let dust = gain - applied;
    if dust > 0 {
        let i = largest_first(backers)[0];
        backers[i].amount += dust;
    }
}

/// Take a pool loss pro rata. Dust comes from the largest backer (ties by id),
/// spilling over to the next largest if needed, so the pool shrinks by exactly `loss`.
pub fn apply_pool_loss(backers: &mut [Backer], loss: u128) {
    if loss == 0 {
        return;
    }
    let total = pool_total(backers);
    assert!(total > 0, "cannot apply a pool delta to an empty pool");
    assert!(loss <= total, "pool loss exceeds pool total");
    let mut taken = 0;
    for b in backers.iter_mut() {
        let share = b.amount * loss / total;
        b.amount -= share;
        taken += share;
    }
    let mut remaining = loss - taken;
    for i in largest_first(backers) {
        if remaining == 0 {
            break;
        }
        let take = remaining.min(backers[i].amount);
        backers[i].amount -= take;
        remaining -= take;
    }
}

pub fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

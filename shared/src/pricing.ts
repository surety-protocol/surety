// MECHANISM.md sections 2-5 as pure functions. bigint only; every division
// rounds down. The Rust contract must return the same numbers for every case in
// shared/test-vectors.json.

import type { Config, Outcome } from "./types.ts";

export const BPS = 10_000n;

export interface PriceConfig {
  reference_value: bigint;
  penalty_bps: number;
  client_share_bps: number;
  max_leverage: number;
  base_fee_bps: number;
  loading_milli: number;
  min_bond: bigint;
}

export function priceConfig(c: Config): PriceConfig {
  return {
    reference_value: BigInt(c.reference_value),
    penalty_bps: c.penalty_bps,
    client_share_bps: c.client_share_bps,
    max_leverage: c.max_leverage,
    base_fee_bps: c.base_fee_bps,
    loading_milli: c.loading_milli,
    min_bond: BigInt(c.min_bond),
  };
}

function checkBps(name: string, v: number): void {
  if (!Number.isInteger(v) || v < 0 || v > 10_000) throw new RangeError(`${name} must be an integer 0..10000, got ${v}`);
}

function checkAmount(name: string, v: bigint): void {
  if (v < 0n) throw new RangeError(`${name} must not be negative`);
}

/** MECHANISM 5: collusion loses money only while leverage * penalty * client share < 10000^2. */
export function isCollusionSafe(c: Pick<PriceConfig, "max_leverage" | "penalty_bps" | "client_share_bps">): boolean {
  return BigInt(c.max_leverage) * BigInt(c.penalty_bps) * BigInt(c.client_share_bps) < BPS * BPS;
}

/** MECHANISM 3.1: k-th settled job between the same agent and client counts value / k. */
export function jobWeight(value: bigint, k: number): bigint {
  checkAmount("value", value);
  if (!Number.isInteger(k) || k < 1) throw new RangeError(`k must be an integer >= 1, got ${k}`);
  return value / BigInt(k);
}

/** MECHANISM 3.2 with the 1-in-5 prior. */
export function failureRateBps(weightedFailures: bigint, weightedJobs: bigint, referenceValue: bigint): number {
  checkAmount("weightedFailures", weightedFailures);
  checkAmount("weightedJobs", weightedJobs);
  if (referenceValue <= 0n) throw new RangeError("referenceValue must be positive");
  if (weightedFailures > weightedJobs) throw new RangeError("weightedFailures cannot exceed weightedJobs");
  return Number(((weightedFailures + referenceValue) * BPS) / (weightedJobs + 5n * referenceValue));
}

/** MECHANISM 3.3: base fee + loading x failure rate x penalty. */
export function premiumBps(failureBps: number, c: Pick<PriceConfig, "base_fee_bps" | "loading_milli" | "penalty_bps">): number {
  checkBps("failureBps", failureBps);
  const variable = (BigInt(c.loading_milli) * BigInt(failureBps) * BigInt(c.penalty_bps)) / 10_000_000n;
  return c.base_fee_bps + Number(variable);
}

/** MECHANISM 3.2: record update after settlement with final score s. */
export function updateRecord(
  record: { weighted_failures: bigint; weighted_jobs: bigint },
  weight: bigint,
  scoreBps: number,
): { weighted_failures: bigint; weighted_jobs: bigint } {
  checkBps("scoreBps", scoreBps);
  return {
    weighted_jobs: record.weighted_jobs + weight,
    weighted_failures: record.weighted_failures + (weight * (BPS - BigInt(scoreBps))) / BPS,
  };
}

export function outcomeFor(scoreBps: number, minScoreBps: number): Outcome {
  checkBps("scoreBps", scoreBps);
  checkBps("minScoreBps", minScoreBps);
  if (scoreBps === 10_000) return "Pass";
  if (scoreBps < minScoreBps) return "Fail";
  return "Partial";
}

export function scoreBps(passed: number, total: number): number {
  if (!Number.isInteger(passed) || !Number.isInteger(total) || total <= 0 || passed < 0 || passed > total) {
    throw new RangeError(`bad check counts ${passed}/${total}`);
  }
  return Math.floor((passed * 10_000) / total);
}

/** MECHANISM 2: may this agent accept a job of this value right now? */
export function canAccept(args: {
  bond: bigint;
  poolTotal: bigint;
  openExposure: bigint;
  value: bigint;
  config: Pick<PriceConfig, "min_bond" | "max_leverage">;
}): { ok: true } | { ok: false; reason: string } {
  const { bond, poolTotal, openExposure, value, config } = args;
  if (bond < config.min_bond) return { ok: false, reason: "bond below minimum" };
  const after = openExposure + value;
  if (after > bond + poolTotal) return { ok: false, reason: "exposure would exceed coverage (bond + pool)" };
  if (after > BigInt(config.max_leverage) * bond) return { ok: false, reason: "exposure would exceed max_leverage x bond" };
  return { ok: true };
}

export interface SettleInput {
  value: bigint;
  scoreBps: number;
  minScoreBps: number;
  premiumBps: number;
  bond: bigint;
  poolTotal: bigint;
  /** false = no backers: the premium is added to the agent's bond (MECHANISM 4.1). */
  hasBackers: boolean;
  config: Pick<PriceConfig, "penalty_bps" | "client_share_bps">;
}

export interface SettleResult {
  outcome: Outcome;
  to_agent: bigint;
  to_client: bigint;
  /** Added to the backers' pool. */
  to_pool: bigint;
  /** Premium added to the agent's bond when there are no backers. */
  to_bond: bigint;
  from_bond: bigint;
  from_pool: bigint;
}

/** MECHANISM 4: who receives what when a job settles. Conserves tokens exactly. */
export function settle(i: SettleInput): SettleResult {
  checkAmount("value", i.value);
  checkAmount("bond", i.bond);
  checkAmount("poolTotal", i.poolTotal);
  checkBps("premiumBps", i.premiumBps);
  const outcome = outcomeFor(i.scoreBps, i.minScoreBps);
  const zero = { to_agent: 0n, to_client: 0n, to_pool: 0n, to_bond: 0n, from_bond: 0n, from_pool: 0n };

  if (outcome === "Fail") {
    const penalty = (i.value * BigInt(i.config.penalty_bps)) / BPS;
    const from_bond = penalty < i.bond ? penalty : i.bond;
    const shortfall = penalty - from_bond;
    const from_pool = shortfall < i.poolTotal ? shortfall : i.poolTotal;
    const collected = from_bond + from_pool;
    // No backers: nobody to receive the backers' share, so the client gets all of it.
    const clientCut = i.hasBackers ? (collected * BigInt(i.config.client_share_bps)) / BPS : collected;
    return {
      ...zero,
      outcome,
      to_client: i.value + clientCut,
      to_pool: collected - clientCut,
      from_bond,
      from_pool,
    };
  }

  const gross = outcome === "Pass" ? i.value : (i.value * BigInt(i.scoreBps)) / BPS;
  const premium = (gross * BigInt(i.premiumBps)) / BPS;
  return {
    ...zero,
    outcome,
    to_agent: gross - premium,
    to_client: i.value - gross,
    to_pool: i.hasBackers ? premium : 0n,
    to_bond: i.hasBackers ? 0n : premium,
  };
}

/**
 * Apply a pool gain (delta > 0) or loss (delta < 0) to backers pro rata.
 * Rounding dust goes to (or comes from) the largest backer, ties broken by id,
 * so the total always changes by exactly delta.
 */
export function applyPoolDelta(
  backers: { backer_id: string; amount: bigint }[],
  delta: bigint,
): { backer_id: string; amount: bigint }[] {
  const total = backers.reduce((s, b) => s + b.amount, 0n);
  if (delta === 0n) return backers.map((b) => ({ ...b }));
  if (total === 0n) throw new RangeError("cannot apply a pool delta to an empty pool");
  if (delta < 0n && -delta > total) throw new RangeError("pool loss exceeds pool total");
  const out = backers.map((b) => ({ backer_id: b.backer_id, amount: b.amount + (b.amount * delta) / total }));
  // BigInt division truncates toward zero, so a loss leaves dust that must still be taken.
  const applied = out.reduce((s, b) => s + b.amount, 0n) - total;
  const dust = delta - applied;
  if (dust !== 0n) {
    const order = [...out.keys()].sort((a, b) => {
      const da = out[a]!.amount;
      const db = out[b]!.amount;
      if (da !== db) return da > db ? -1 : 1;
      return out[a]!.backer_id < out[b]!.backer_id ? -1 : 1;
    });
    let remaining = dust;
    for (const idx of order) {
      if (remaining === 0n) break;
      const b = out[idx]!;
      if (remaining > 0n) {
        b.amount += remaining;
        remaining = 0n;
      } else {
        const take = -remaining < b.amount ? -remaining : b.amount;
        b.amount -= take;
        remaining += take;
      }
    }
  }
  return out;
}

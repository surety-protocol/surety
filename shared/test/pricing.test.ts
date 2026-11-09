import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyPoolDelta,
  canAccept,
  failureRateBps,
  isCollusionSafe,
  jobWeight,
  outcomeFor,
  premiumBps,
  scoreBps,
  settle,
  updateRecord,
} from "../src/pricing.ts";

const V = JSON.parse(readFileSync(new URL("../test-vectors.json", import.meta.url), "utf8"));
const cfg = {
  reference_value: BigInt(V.config.reference_value),
  penalty_bps: V.config.penalty_bps,
  client_share_bps: V.config.client_share_bps,
  max_leverage: V.config.max_leverage,
  base_fee_bps: V.config.base_fee_bps,
  loading_milli: V.config.loading_milli,
  min_bond: BigInt(V.config.min_bond),
};

for (const c of V.failure_rate) {
  test(`failure rate: ${c.name}`, () => {
    assert.equal(failureRateBps(BigInt(c.weighted_failures), BigInt(c.weighted_jobs), cfg.reference_value), c.expected_bps);
  });
}

for (const c of V.premium) {
  test(`premium for failure rate ${c.failure_rate_bps}`, () => {
    assert.equal(premiumBps(c.failure_rate_bps, cfg), c.expected_bps);
  });
}

for (const c of V.job_weight) {
  test(`job weight ${c.value}/${c.k}`, () => {
    assert.equal(jobWeight(BigInt(c.value), c.k), BigInt(c.expected));
  });
}

for (const c of V.record_update) {
  test(`record update: ${c.name}`, () => {
    const r = updateRecord({ weighted_failures: BigInt(c.weighted_failures), weighted_jobs: BigInt(c.weighted_jobs) }, BigInt(c.weight), c.score_bps);
    assert.equal(r.weighted_failures, BigInt(c.expected_failures));
    assert.equal(r.weighted_jobs, BigInt(c.expected_jobs));
  });
}

for (const c of V.settle) {
  test(`settle: ${c.name}`, () => {
    const r = settle({
      value: BigInt(c.value),
      scoreBps: c.score_bps,
      minScoreBps: c.min_score_bps,
      premiumBps: c.premium_bps,
      bond: BigInt(c.bond),
      poolTotal: BigInt(c.pool_total),
      hasBackers: c.has_backers,
      config: cfg,
    });
    const got = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
    assert.deepEqual(got, c.expected);
    // Conservation: escrow + penalty in == everything out.
    const inflow = BigInt(c.value) + r.from_bond + r.from_pool;
    const outflow = r.to_agent + r.to_client + r.to_pool + r.to_bond;
    assert.equal(inflow, outflow, "tokens must be conserved");
  });
}

for (const c of V.can_accept) {
  test(`can accept: ${c.name}`, () => {
    const r = canAccept({
      bond: BigInt(c.bond),
      poolTotal: BigInt(c.pool_total),
      openExposure: BigInt(c.open_exposure),
      value: BigInt(c.value),
      config: cfg,
    });
    assert.equal(r.ok, c.expected);
  });
}

for (const c of V.pool_delta) {
  test(`pool delta: ${c.name}`, () => {
    const before = c.backers.map(([id, a]: [string, string]) => ({ backer_id: id, amount: BigInt(a) }));
    const after = applyPoolDelta(before, BigInt(c.delta));
    assert.deepEqual(after.map((b) => [b.backer_id, b.amount.toString()]), c.expected);
    const total = (xs: { amount: bigint }[]) => xs.reduce((s, b) => s + b.amount, 0n);
    assert.equal(total(after) - total(before), BigInt(c.delta));
  });
}

for (const c of V.collusion_safe) {
  test(`collusion safe: leverage ${c.max_leverage}, penalty ${c.penalty_bps}, share ${c.client_share_bps}`, () => {
    assert.equal(isCollusionSafe(c), c.expected);
  });
}

test("score from check counts", () => {
  assert.equal(scoreBps(7, 7), 10000);
  assert.equal(scoreBps(2, 7), 2857);
  assert.equal(scoreBps(5, 7), 7142);
  assert.equal(scoreBps(0, 3), 0);
  assert.throws(() => scoreBps(1, 0));
  assert.throws(() => scoreBps(8, 7));
  assert.throws(() => scoreBps(-1, 7));
});

test("outcome boundaries", () => {
  assert.equal(outcomeFor(10000, 5000), "Pass");
  assert.equal(outcomeFor(9999, 5000), "Partial");
  assert.equal(outcomeFor(5000, 5000), "Partial");
  assert.equal(outcomeFor(4999, 5000), "Fail");
  assert.equal(outcomeFor(0, 1), "Fail");
});

test("bad inputs are rejected, never silently accepted", () => {
  assert.throws(() => jobWeight(10n, 0));
  assert.throws(() => jobWeight(-1n, 1));
  assert.throws(() => failureRateBps(2n, 1n, 50n), /cannot exceed/);
  assert.throws(() => failureRateBps(0n, 0n, 0n));
  assert.throws(() => premiumBps(10001, cfg));
  assert.throws(() => premiumBps(1.5, cfg));
  assert.throws(() => applyPoolDelta([], 5n), /empty pool/);
  assert.throws(() => applyPoolDelta([{ backer_id: "a", amount: 5n }], -6n), /exceeds/);
});

test("collusion always loses money under the default config (MECHANISM 5)", () => {
  // Agent and partner client fail every open job on purpose, across many exposure levels.
  const bond = 100_000_000n;
  for (let mult = 1n; mult <= 8n; mult++) {
    const exposure = bond * mult; // open jobs, all failing
    const jobs = 10n;
    const value = exposure / jobs;
    let b = bond;
    let pool = 10_000_000_000n;
    let partnerGain = 0n;
    let pairLoss = 0n;
    for (let i = 0n; i < jobs; i++) {
      const r = settle({ value, scoreBps: 0, minScoreBps: 5000, premiumBps: 700, bond: b, poolTotal: pool, hasBackers: true, config: cfg });
      b -= r.from_bond;
      pool -= r.from_pool;
      pool += r.to_pool;
      partnerGain += r.to_client - value; // the escrow refund is the partner's own money
      pairLoss += r.from_bond;
    }
    assert.ok(pairLoss > partnerGain, `exposure ${mult}x bond: pair must lose money (lost ${pairLoss}, gained ${partnerGain})`);
  }
});

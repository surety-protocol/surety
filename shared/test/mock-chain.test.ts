import { test } from "node:test";
import assert from "node:assert/strict";
import { MockChain } from "../src/mock-chain.ts";
import { ChainError } from "../src/chain.ts";

const T = (n: number) => (BigInt(n) * 1_000_000n).toString(); // n tUSDC in units
const HASH = "a".repeat(64);
const HASH2 = "b".repeat(64);

function setup(config = {}) {
  const c = new MockChain({ judgeId: "judge", panelId: "panel", config });
  for (const who of ["client", "agent", "agent2", "backer", "fake1", "fake2", "fake3"]) c.mint(who, T(10_000));
  return c;
}

async function newAgent(c: MockChain, id: string, bond = 100) {
  await c.as(id).registerAgent();
  await c.as(id).depositBond(T(bond));
}

async function runJob(c: MockChain, opts: { client?: string; agent?: string; value?: number; passed: number; total: number }) {
  const client = opts.client ?? "client";
  const agent = opts.agent ?? "agent";
  const now = await c.now();
  const { value: id } = await c.as(client).postJob({ value: T(opts.value ?? 50), spec_hash: HASH, spec_url: "agents/jobs/x.json", deadline_ms: now + 3_600_000 });
  await c.as(agent).acceptJob(id);
  await c.as(agent).deliver(id, "agents/patches/x.diff", HASH2);
  const score = Math.floor((opts.passed * 10000) / opts.total);
  await c.as("judge").submitVerdict({ job_id: id, score_bps: score, checks_passed: opts.passed, checks_total: opts.total, receipts_hash: HASH });
  c.advance(c.config.appeal_window_ms);
  await c.as("anyone").settle(id);
  return id;
}

test("pass: agent paid minus premium, premium to bond when no backers", async () => {
  const c = setup();
  await newAgent(c, "agent");
  const before = c.balanceOf("agent");
  const id = await runJob(c, { passed: 7, total: 7 });
  const job = (await c.getJob(id))!;
  assert.equal(job.status, "Settled");
  assert.equal(job.premium_bps, 700);
  assert.equal(job.settlement!.outcome, "Pass");
  assert.equal(c.balanceOf("agent") - before, 46_500_000n);
  assert.equal((await c.getAgent("agent"))!.bond, T(100) === "100000000" ? "103500000" : "");
});

test("fail: client refunded plus whole penalty from bond (no backers)", async () => {
  const c = setup();
  await newAgent(c, "agent");
  const before = c.balanceOf("client");
  const id = await runJob(c, { passed: 2, total: 7 });
  const job = (await c.getJob(id))!;
  assert.equal(job.settlement!.outcome, "Fail");
  assert.equal(c.balanceOf("client") - before, 10_000_000n); // paid 50, got 60 back
  const a = (await c.getAgent("agent"))!;
  assert.equal(a.bond, "90000000");
  assert.equal(a.jobs_failed, 1);
  assert.ok(a.premium_bps > 700, "price rises after a fail");
});

test("fail with backers: half the penalty to the client, half to backers", async () => {
  const c = setup();
  await newAgent(c, "agent");
  await c.as("backer").depositPool("agent", T(200));
  const before = c.balanceOf("client");
  await runJob(c, { passed: 0, total: 7 });
  assert.equal(c.balanceOf("client") - before, 5_000_000n);
  const a = (await c.getAgent("agent"))!;
  assert.equal(a.bond, "90000000");
  assert.equal(a.pool_total, "205000000");
});

test("partial: split by score, premium to backers", async () => {
  const c = setup();
  await newAgent(c, "agent");
  await c.as("backer").depositPool("agent", T(100));
  const agentBefore = c.balanceOf("agent");
  const clientBefore = c.balanceOf("client");
  const id = await runJob(c, { passed: 4, total: 5 });
  const s = (await c.getJob(id))!.settlement!;
  assert.equal(s.outcome, "Partial");
  assert.equal(c.balanceOf("agent") - agentBefore, 37_200_000n);
  assert.equal(c.balanceOf("client") - clientBefore, -40_000_000n);
  assert.equal((await c.getAgent("agent"))!.pool_total, "102800000");
});

test("bond short: pool covers the rest of the penalty", async () => {
  const c = setup({ min_bond: T(10) });
  await newAgent(c, "agent", 10);
  await c.as("backer").depositPool("agent", T(500));
  // 80 tUSDC job: penalty 16 > bond 10.
  const id = await runJob(c, { value: 80, passed: 0, total: 5 });
  const s = (await c.getJob(id))!.settlement!;
  assert.equal(s.from_bond, "10000000");
  assert.equal(s.from_pool, "6000000");
  assert.equal(s.to_client, "88000000");
  assert.equal((await c.getAgent("agent"))!.bond, "0");
});

test("accept rules: min bond, coverage, leverage, self-hire", async () => {
  const c = setup();
  await c.as("agent").registerAgent();
  const now = await c.now();
  const post = async (value: number, from = "client") =>
    (await c.as(from).postJob({ value: T(value), spec_hash: HASH, spec_url: "x", deadline_ms: now + 1e6 })).value;
  await assert.rejects(c.as("agent").acceptJob(await post(50)), /bond below minimum/);
  await c.as("agent").depositBond(T(100));
  await assert.rejects(c.as("agent").acceptJob(await post(150)), /coverage/);
  await c.as("backer").depositPool("agent", T(2000));
  const ok = await post(800);
  await c.as("agent").acceptJob(ok);
  await assert.rejects(c.as("agent").acceptJob(await post(1)), /max_leverage/);
  await assert.rejects(c.as("agent").acceptJob(await post(1, "agent")), /own job/);
  await assert.rejects(c.as("nobody").acceptJob(0), /not a registered agent/);
});

test("only the judge submits, only once, and the score must match the counts", async () => {
  const c = setup();
  await newAgent(c, "agent");
  const now = await c.now();
  const { value: id } = await c.as("client").postJob({ value: T(50), spec_hash: HASH, spec_url: "x", deadline_ms: now + 1e6 });
  await c.as("agent").acceptJob(id);
  const v = { job_id: id, score_bps: 10000, checks_passed: 7, checks_total: 7, receipts_hash: HASH };
  await assert.rejects(c.as("judge").submitVerdict(v), /not delivered/);
  await c.as("agent").deliver(id, "p", HASH2);
  await assert.rejects(c.as("agent").submitVerdict(v), /only the judge/);
  await assert.rejects(c.as("judge").submitVerdict({ ...v, score_bps: 9000 }), /does not match/);
  await assert.rejects(c.as("judge").submitVerdict({ ...v, receipts_hash: "nope" }), /receipts_hash/);
  await c.as("judge").submitVerdict(v);
  await assert.rejects(c.as("judge").submitVerdict(v), /not delivered/);
  await assert.rejects(c.as("x").settle(id), /appeal window still open/);
  c.advance(c.config.appeal_window_ms);
  await c.as("x").settle(id);
  await assert.rejects(c.as("x").settle(id), /not ready/);
});

test("appeal by agent that wins: deposit refunded, new score used", async () => {
  const c = setup();
  await newAgent(c, "agent");
  const now = await c.now();
  const { value: id } = await c.as("client").postJob({ value: T(50), spec_hash: HASH, spec_url: "x", deadline_ms: now + 1e6 });
  await c.as("agent").acceptJob(id);
  await c.as("agent").deliver(id, "p", HASH2);
  await c.as("judge").submitVerdict({ job_id: id, score_bps: 2857, checks_passed: 2, checks_total: 7, receipts_hash: HASH });
  await assert.rejects(c.as("backer").appeal(id), /only the client or the agent/);
  const before = c.balanceOf("agent");
  await c.as("agent").appeal(id);
  await assert.rejects(c.as("client").appeal(id), /only a judged job|already appealed/);
  await assert.rejects(c.as("agent").resolveAppeal(id, 10000), /only the appeal panel/);
  await c.as("panel").resolveAppeal(id, 10000);
  await c.as("x").settle(id);
  const s = (await c.getJob(id))!.settlement!;
  assert.equal(s.outcome, "Pass");
  assert.equal(c.balanceOf("agent") - before, 46_500_000n); // deposit back + payout
});

test("appeal by client that loses: deposit goes to the agent", async () => {
  const c = setup();
  await newAgent(c, "agent");
  const now = await c.now();
  const { value: id } = await c.as("client").postJob({ value: T(50), spec_hash: HASH, spec_url: "x", deadline_ms: now + 1e6 });
  await c.as("agent").acceptJob(id);
  await c.as("agent").deliver(id, "p", HASH2);
  await c.as("judge").submitVerdict({ job_id: id, score_bps: 10000, checks_passed: 7, checks_total: 7, receipts_hash: HASH });
  const agentBefore = c.balanceOf("agent");
  await c.as("client").appeal(id);
  await c.as("panel").resolveAppeal(id, 10000);
  assert.equal(c.balanceOf("agent") - agentBefore, 5_000_000n);
  c.advance(1);
  await c.as("x").settle(id);
});

test("appeal window closes", async () => {
  const c = setup();
  await newAgent(c, "agent");
  const now = await c.now();
  const { value: id } = await c.as("client").postJob({ value: T(50), spec_hash: HASH, spec_url: "x", deadline_ms: now + 1e6 });
  await c.as("agent").acceptJob(id);
  await c.as("agent").deliver(id, "p", HASH2);
  await c.as("judge").submitVerdict({ job_id: id, score_bps: 0, checks_passed: 0, checks_total: 7, receipts_hash: HASH });
  c.advance(c.config.appeal_window_ms);
  await assert.rejects(c.as("agent").appeal(id), /window closed/);
});

test("cancel: open job refunded; missed deadline counts as a fail", async () => {
  const c = setup();
  await newAgent(c, "agent");
  const now = await c.now();
  const { value: open } = await c.as("client").postJob({ value: T(50), spec_hash: HASH, spec_url: "x", deadline_ms: now + 1000 });
  const before = c.balanceOf("client");
  await assert.rejects(c.as("agent").cancelExpired(open), /only the client/);
  await c.as("client").cancelExpired(open);
  assert.equal(c.balanceOf("client") - before, 50_000_000n);
  const { value: late } = await c.as("client").postJob({ value: T(50), spec_hash: HASH, spec_url: "x", deadline_ms: now + 1000 });
  await c.as("agent").acceptJob(late);
  await assert.rejects(c.as("client").cancelExpired(late), /cannot be cancelled now/);
  c.advance(1000);
  await assert.rejects(c.as("agent").deliver(late, "p", HASH2), /deadline/);
  await c.as("client").cancelExpired(late);
  assert.equal((await c.getJob(late))!.settlement!.outcome, "Fail");
});

test("withdrawals: locked while jobs are open and during cooldown; min bond kept", async () => {
  const c = setup();
  await newAgent(c, "agent", 300);
  await c.as("backer").depositPool("agent", T(100));
  const now = await c.now();
  const { value: id } = await c.as("client").postJob({ value: T(50), spec_hash: HASH, spec_url: "x", deadline_ms: now + 1e6 });
  await c.as("agent").acceptJob(id);
  await assert.rejects(c.as("agent").withdrawBond(T(10)), /locked/);
  await assert.rejects(c.as("backer").withdrawPool("agent", T(10)), /locked/);
  await c.as("agent").deliver(id, "p", HASH2);
  await c.as("judge").submitVerdict({ job_id: id, score_bps: 10000, checks_passed: 1, checks_total: 1, receipts_hash: HASH });
  c.advance(c.config.appeal_window_ms);
  await c.as("x").settle(id);
  await assert.rejects(c.as("agent").withdrawBond(T(10)), /cooldown/);
  c.advance(c.config.withdraw_cooldown_ms);
  await assert.rejects(c.as("agent").withdrawBond(T(250)), /min_bond/);
  await c.as("agent").withdrawBond(T(150));
  await c.as("backer").withdrawPool("agent", T(50));
  await assert.rejects(c.as("fake1").withdrawPool("agent", T(1)), /no stake/);
});

test("deposits: only registered agents bond; agents can't back themselves; bad msgs refunded", async () => {
  const c = setup();
  await assert.rejects(c.as("client").depositBond(T(100)), /registered agent/);
  await c.as("agent").registerAgent();
  await assert.rejects(c.as("agent").registerAgent(), /already registered/);
  await assert.rejects(c.as("agent").depositPool("agent", T(1)), /cannot back itself/);
  await assert.rejects(c.as("backer").depositPool("ghost", T(1)), /unknown agent/);
  const now = await c.now();
  await assert.rejects(c.as("client").postJob({ value: T(5), spec_hash: "xyz", spec_url: "x", deadline_ms: now + 1 }), /spec_hash/);
  await assert.rejects(c.as("client").postJob({ value: T(5), spec_hash: HASH, spec_url: "x", deadline_ms: now - 1 }), /future/);
  await assert.rejects(c.as("client").postJob({ value: "0", spec_hash: HASH, spec_url: "x", deadline_ms: now + 1 }), /positive/);
  await assert.rejects(c.as("broke").postJob({ value: T(5), spec_hash: HASH, spec_url: "x", deadline_ms: now + 1 }), /insufficient/);
  assert.equal(c.balanceOf("client"), 10_000_000_000n, "failed calls move no tokens");
});

test("unsafe config is rejected (MECHANISM 5)", () => {
  assert.throws(() => new MockChain({ judgeId: "j", panelId: "p", config: { max_leverage: 10 } }), ChainError);
});

test("cheater with 3 sock puppets gets less weight and a higher price than an honest agent", async () => {
  const c = setup();
  await newAgent(c, "agent"); // cheater
  await newAgent(c, "agent2"); // honest
  for (let i = 0; i < 9; i++) {
    await runJob(c, { client: `fake${(i % 3) + 1}`, agent: "agent", passed: 1, total: 1 });
  }
  for (let i = 0; i < 9; i++) {
    const client = `client${i}`;
    c.mint(client, T(100));
    await runJob(c, { client, agent: "agent2", passed: 1, total: 1 });
  }
  const cheater = (await c.getAgent("agent"))!;
  const honest = (await c.getAgent("agent2"))!;
  // 3 puppets x 3 jobs: 3 x (50 + 25 + 16.67) = 275 vs honest 9 x 50 = 450.
  // Known weakness (flagged to the team): more puppets narrow this gap.
  assert.equal(cheater.weighted_jobs, "274999998"); // 16666666 rounds down
  assert.equal(honest.weighted_jobs, "450000000");
  assert.ok(cheater.premium_bps > honest.premium_bps, `cheater ${cheater.premium_bps} should pay more than honest ${honest.premium_bps}`);
});

test("colluding pair loses money even when draining the pool", async () => {
  const c = setup({ min_bond: T(10) });
  await newAgent(c, "agent", 100);
  await c.as("backer").depositPool("agent", T(5000));
  const pairStart = c.balanceOf("agent") + c.balanceOf("fake1") + 100_000_000n; // bond counts as the pair's money
  // Open 8x bond of jobs from the partner and fail them all on purpose.
  const now = await c.now();
  const ids: number[] = [];
  for (let i = 0; i < 8; i++) {
    const { value } = await c.as("fake1").postJob({ value: T(100), spec_hash: HASH, spec_url: "x", deadline_ms: now + 1e6 });
    await c.as("agent").acceptJob(value);
    ids.push(value);
  }
  for (const id of ids) {
    await c.as("agent").deliver(id, "p", HASH2);
    await c.as("judge").submitVerdict({ job_id: id, score_bps: 0, checks_passed: 0, checks_total: 1, receipts_hash: HASH });
  }
  c.advance(c.config.appeal_window_ms);
  for (const id of ids) await c.as("x").settle(id);
  const a = (await c.getAgent("agent"))!;
  const pairEnd = c.balanceOf("agent") + c.balanceOf("fake1") + BigInt(a.bond);
  assert.ok(pairEnd < pairStart, `pair should lose money: start ${pairStart}, end ${pairEnd}`);
});

test("token invariant holds through a long random run", async () => {
  const c = setup({ min_bond: T(10) });
  await newAgent(c, "agent", 200);
  await newAgent(c, "agent2", 200);
  await c.as("backer").depositPool("agent", T(300));
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let i = 0; i < 60; i++) {
    const agent = rand() < 0.5 ? "agent" : "agent2";
    const passed = Math.floor(rand() * 6);
    try {
      await runJob(c, { agent, value: 5 + Math.floor(rand() * 40), passed, total: 5 });
    } catch (e) {
      assert.ok(e instanceof ChainError, String(e));
    }
    c.checkInvariant();
  }
  const settled = (await c.listJobsByStatus("Settled", 1000)).length;
  assert.ok(settled > 30);
});

test("views and events", async () => {
  const c = setup();
  await newAgent(c, "agent");
  await runJob(c, { passed: 1, total: 1 });
  assert.equal((await c.listJobs(0, 10)).length, 1);
  assert.equal((await c.listAgents(0, 10))[0]!.agent_id, "agent");
  assert.deepEqual(await c.getPrice("agent"), { failure_rate_bps: Math.floor((50e6 * 1e4) / 300e6), premium_bps: 100 + Math.floor((1500 * 1666 * 2000) / 1e7) });
  assert.equal(await c.getJob(99), null);
  assert.equal(await c.getAgent("ghost"), null);
  const names = c.events.map((e) => e.event);
  for (const n of ["agent_registered", "bond_deposited", "job_posted", "job_accepted", "job_delivered", "verdict_submitted", "job_settled"]) {
    assert.ok(names.includes(n), `missing event ${n}`);
  }
});

test("experiment switches: premium to reserve, value/k^2 (off by default)", async () => {
  const run = async (opts: { premiumWithoutBackers?: "bond" | "reserve"; repeatClientWeight?: "value/k" | "value/k2" }) => {
    const c = new MockChain({ judgeId: "judge", panelId: "panel", ...opts });
    for (const who of ["client", "agent"]) c.mint(who, T(10_000));
    await newAgent(c, "agent");
    await runJob(c, { passed: 1, total: 1 });
    await runJob(c, { passed: 1, total: 1 });
    return { c, a: (await c.getAgent("agent"))! };
  };
  const base = await run({});
  const premiums = BigInt(base.a.bond) - 100_000_000n; // 3.5 + a lower second premium, into the bond
  assert.ok(premiums > 0n);
  assert.equal(base.a.weighted_jobs, "75000000"); // 50 + 50/2
  const reserve = await run({ premiumWithoutBackers: "reserve" });
  assert.equal(reserve.a.bond, "100000000");
  assert.equal(reserve.c.balanceOf("reserve.surety.testnet"), premiums);
  const k2 = await run({ repeatClientWeight: "value/k2" });
  assert.equal(k2.a.weighted_jobs, "62500000"); // 50 + 50/4
});

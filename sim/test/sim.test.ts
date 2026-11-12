import assert from "node:assert/strict";
import { test } from "node:test";
import { runSimulation } from "../src/model.ts";

test("simulation runs 500 market jobs and is deterministic", async () => {
  const a = await runSimulation();
  const b = await runSimulation();
  assert.equal(a.config.market_jobs, 500);
  assert.equal(a.rounds.length, 20);
  assert.equal(a.agents.length, 21);
  assert.deepEqual(a.findings, b.findings);
  assert.deepEqual(a.jobs, b.jobs);
});

test("every settled job conserves tokens", async () => {
  const r = await runSimulation({ rounds: 4 });
  for (const j of r.jobs) {
    const into = BigInt(j.value) + BigInt(j.from_bond) + BigInt(j.from_pool);
    const premiumToBond = BigInt(j.value) - BigInt(j.to_agent) - BigInt(j.to_client) - BigInt(j.to_pool);
    const out = BigInt(j.to_agent) + BigInt(j.to_client) + BigInt(j.to_pool) + (j.outcome === "Fail" ? 0n : premiumToBond);
    assert.equal(out, into, `job ${j.job_id}`);
  }
});

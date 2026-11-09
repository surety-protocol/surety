// Whole jobs, end to end: post -> accept -> deliver -> real tests -> 3 verified
// AI judges (fake NEAR AI with real signatures) -> receipts -> verdict on chain
// -> appeal window -> settle -> balances.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { REPO_ROOT } from "@surety/shared/env";
import { MockChain } from "@surety/shared/mock-chain";
import { sha256Hex } from "@surety/shared/hash";
import { postJob, runAgent, SCENARIOS } from "@surety/agents";
import { NearAiClient } from "../src/nearai/client.ts";
import { NearAiPanel } from "../src/ai-panel.ts";
import { JudgeWorker } from "../src/worker.ts";
import { DemoRunner } from "../src/demo.ts";
import { createApi } from "../src/api.ts";
import { fakeGpuVerifier, fakeNearAi, fakeQuoteVerifier, MODELS } from "./helpers/fake-nearai.ts";

const T = (n: number) => (BigInt(n) * 1_000_000n).toString();
const SECRET = "nearai-secret-key-0123456789";

async function world() {
  const receiptsDir = await mkdtemp(join(tmpdir(), "surety-receipts-"));
  const chain = new MockChain({ judgeId: "judge.t", panelId: "panel.t" });
  for (const a of ["client.t", "honest.t", "sloppy.t", "cheater.t", "fake1.t", "fake2.t", "fake3.t", "backer.t"]) chain.mint(a, T(10_000));
  const fake = fakeNearAi({});
  const panel = new NearAiPanel({
    client: new NearAiClient("https://cloud-api.near.ai/v1", SECRET, fake.fetch, async () => {}),
    models: MODELS,
    verifyQuote: fakeQuoteVerifier,
    verifyGpu: fakeGpuVerifier,
  });
  const steps: string[] = [];
  const worker = new JudgeWorker({ chain, judgeId: "judge.t", repoRoot: REPO_ROOT, receiptsDir, panel, secrets: [SECRET], log: () => {}, onStep: (_, s) => steps.push(s) });
  return { chain, worker, receiptsDir, fake, steps, cleanup: () => rm(receiptsDir, { recursive: true, force: true }) };
}

async function deliveredJob(chain: MockChain, kind: "honest" | "sloppy" | "cheater", agentId: string, clientId = "client.t") {
  const id = await postJob({ chain, clientId, repoRoot: REPO_ROOT, specRef: SCENARIOS[kind].spec, value: T(50), deadlineMs: (await chain.now()) + 3_600_000 });
  await runAgent({ chain, agentId, jobId: id, repoRoot: REPO_ROOT, patchRef: SCENARIOS[kind].patch });
  return id;
}

test("honest agent: 7/7 checks, paid 46.50 tUSDC, receipts match the on-chain hash", async () => {
  const w = await world();
  try {
    const id = await deliveredJob(w.chain, "honest", "honest.t");
    const before = w.chain.balanceOf("honest.t");
    const r = await w.worker.processJob((await w.chain.getJob(id))!);
    assert.equal(r.verdict.checks_passed, 7, JSON.stringify(r.verdict, null, 2));
    assert.equal(r.verdict.score_bps, 10000);
    assert.deepEqual(r.verdict.problems, []);
    const job = (await w.chain.getJob(id))!;
    assert.equal(job.status, "Judged");
    // The on-chain hash is the hash of the published verdict file.
    const bytes = await readFile(join(w.receiptsDir, String(id), "verdict.json"));
    assert.equal(sha256Hex(bytes), job.verdict!.receipts_hash);
    const files = (await readdir(join(w.receiptsDir, String(id)))).sort();
    assert.deepEqual(files, ["judge-Qwen_Qwen3.8-27B.json", "judge-deepseek-ai_DeepSeek-V4.1-Flash-1017.json", "judge-z-ai_glm-5.3-flash.json", "tests.json", "verdict.json"]);
    for (const f of files) assert.ok(!(await readFile(join(w.receiptsDir, String(id), f), "utf8")).includes(SECRET), `${f} leaks the API key`);
    // Not settled during the appeal window, settled after it.
    assert.deepEqual((await w.worker.tick()).settled, []);
    w.chain.advance(w.chain.config.appeal_window_ms);
    assert.deepEqual((await w.worker.tick()).settled, [id]);
    assert.equal(w.chain.balanceOf("honest.t") - before, 46_500_000n);
  } finally {
    await w.cleanup();
  }
});

test("sloppy agent: 2/7 checks, client refunded 60 tUSDC from the agent's bond", async () => {
  const w = await world();
  try {
    const id = await deliveredJob(w.chain, "sloppy", "sloppy.t");
    const clientBefore = w.chain.balanceOf("client.t");
    const r = await w.worker.processJob((await w.chain.getJob(id))!);
    assert.equal(r.verdict.checks_passed, 2);
    assert.equal(r.verdict.score_bps, 2857);
    const ai = r.verdict.checks.filter((c) => c.type === "ai");
    assert.ok(ai.every((c) => !c.pass), "both AI checks fail");
    w.chain.advance(w.chain.config.appeal_window_ms);
    await w.worker.tick();
    const job = (await w.chain.getJob(id))!;
    assert.equal(job.settlement!.outcome, "Fail");
    assert.equal(w.chain.balanceOf("client.t") - clientBefore, 60_000_000n);
    const agent = (await w.chain.getAgent("sloppy.t"))!;
    assert.equal(agent.bond, "90000000");
    assert.ok(agent.premium_bps > 700, "price rises after the fail");
  } finally {
    await w.cleanup();
  }
});

test("tampered patch file: hash mismatch scores 0 and no AI calls are made", async () => {
  const w = await world();
  try {
    const id = await postJob({ chain: w.chain, clientId: "client.t", repoRoot: REPO_ROOT, specRef: SCENARIOS.honest.spec, value: T(50), deadlineMs: (await w.chain.now()) + 3_600_000 });
    await w.chain.as("honest.t").registerAgent();
    await w.chain.as("honest.t").depositBond(T(100));
    await w.chain.as("honest.t").acceptJob(id);
    await w.chain.as("honest.t").deliver(id, SCENARIOS.honest.patch, "c".repeat(64)); // wrong hash
    const r = await w.worker.processJob((await w.chain.getJob(id))!);
    assert.equal(r.verdict.score_bps, 0);
    assert.ok(r.verdict.problems.some((p) => /patch hash mismatch/.test(p)));
    assert.equal(w.fake.calls.completions, 0);
  } finally {
    await w.cleanup();
  }
});

test("bad spec reference: escaping the repo is refused and scores 0", async () => {
  const w = await world();
  try {
    const now = await w.chain.now();
    const { value: id } = await w.chain.as("client.t").postJob({ value: T(50), spec_hash: "d".repeat(64), spec_url: "../../../etc/passwd", deadline_ms: now + 1e6 });
    await w.chain.as("honest.t").registerAgent();
    await w.chain.as("honest.t").depositBond(T(100));
    await w.chain.as("honest.t").acceptJob(id);
    await w.chain.as("honest.t").deliver(id, SCENARIOS.honest.patch, sha256Hex(await readFile(join(REPO_ROOT, SCENARIOS.honest.patch))));
    const r = await w.worker.processJob((await w.chain.getJob(id))!);
    assert.equal(r.verdict.score_bps, 0);
    assert.ok(r.verdict.problems.some((p) => /escapes the repository/.test(p)), JSON.stringify(r.verdict.problems));
  } finally {
    await w.cleanup();
  }
});

test("worker tick judges every delivered job once, even if called repeatedly", async () => {
  const w = await world();
  try {
    const a = await deliveredJob(w.chain, "honest", "honest.t");
    const b = await deliveredJob(w.chain, "sloppy", "sloppy.t");
    const first = await w.worker.tick();
    assert.deepEqual(first.judged.sort(), [a, b].sort());
    assert.deepEqual(first.errors, []);
    const second = await w.worker.tick();
    assert.deepEqual(second.judged, []);
  } finally {
    await w.cleanup();
  }
});

test("regression: demo runner and poll loop racing on the same job judge it exactly once", async () => {
  const w = await world();
  try {
    const id = await deliveredJob(w.chain, "honest", "honest.t");
    const job = (await w.chain.getJob(id))!;
    const [a, b, t] = await Promise.all([w.worker.processJob(job), w.worker.processJob(job), w.worker.tick()]);
    assert.equal(a, b, "concurrent callers share one result");
    assert.deepEqual(t.errors, []);
    assert.equal(w.fake.calls.completions, 6, "3 models x 2 AI checks, not doubled");
    assert.equal(w.fake.calls.attestations, 3);
    assert.equal((await w.chain.getJob(id))!.status, "Judged");
    assert.deepEqual((await w.worker.tick()).judged, [], "never judged again");
  } finally {
    await w.cleanup();
  }
});

test("a failed submit can be retried and replaces the earlier receipts", async () => {
  const w = await world();
  try {
    const id = await deliveredJob(w.chain, "sloppy", "sloppy.t");
    const job = (await w.chain.getJob(id))!;
    const realAs = w.chain.as.bind(w.chain);
    let fail = true;
    w.chain.as = (acct: string) => {
      const actor = realAs(acct);
      return { ...actor, submitVerdict: async (v) => (fail ? Promise.reject(new Error("rpc timeout")) : actor.submitVerdict(v)) };
    };
    await assert.rejects(w.worker.processJob(job), /rpc timeout/);
    fail = false;
    const r = await w.worker.processJob(job);
    assert.equal(r.verdict.checks_passed, 2);
    assert.equal((await w.chain.getJob(id))!.verdict!.receipts_hash, r.receiptsHash);
  } finally {
    await w.cleanup();
  }
});

test("cheater scenario: self-dealt easy jobs pass, but carry less weight", async () => {
  const w = await world();
  try {
    for (const c of ["fake1.t", "fake2.t", "fake3.t", "fake1.t"]) {
      const id = await deliveredJob(w.chain, "cheater", "cheater.t", c);
      const r = await w.worker.processJob((await w.chain.getJob(id))!);
      assert.equal(r.verdict.checks_passed, 1);
      // Settle before the next job: open jobs count against the bond (exposure limit).
      w.chain.advance(w.chain.config.appeal_window_ms);
      assert.deepEqual((await w.worker.tick()).settled, [id]);
    }
    const agent = (await w.chain.getAgent("cheater.t"))!;
    assert.equal(agent.jobs_passed, 4);
    assert.equal(agent.weighted_jobs, T(175), "50 + 50 + 50 + 25 (second job from fake1)");
  } finally {
    await w.cleanup();
  }
});

test("demo API: run a scenario, follow its steps, fetch receipts, rate limits and validation", async () => {
  const w = await world();
  const demo = new DemoRunner({
    chain: w.chain,
    worker: w.worker,
    accounts: { client: "client.t", honest: "honest.t", sloppy: "sloppy.t", cheater: "cheater.t", fakeClients: ["fake1.t"] },
    repoRoot: REPO_ROOT,
    maxPerHour: 2,
  });
  const server = createApi({ chain: w.chain, demo, receiptsDir: w.receiptsDir, corsOrigins: ["http://localhost:5173"] });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, init?: RequestInit) => fetch(base + path, init);
  const post = (body: unknown) => call("/demo/run", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:5173" }, body: JSON.stringify(body) });
  try {
    const health = await call("/health", { headers: { origin: "http://evil.example" } });
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("access-control-allow-origin"), null, "unknown origins get no CORS header");
    assert.equal((await post({ scenario: "rm -rf" })).status, 400);

    const run = await post({ scenario: "sloppy" });
    assert.equal(run.status, 202);
    assert.equal(run.headers.get("access-control-allow-origin"), "http://localhost:5173");
    const { job_id } = (await run.json()) as { job_id: number };
    assert.equal((await post({ scenario: "honest" })).status, 429, "one run at a time");

    let status: { job: { status: string }; steps: { name: string }[] } | null = null;
    for (let i = 0; i < 200; i++) {
      status = (await (await call(`/demo/status/${job_id}`)).json()) as typeof status;
      if (status!.job.status === "Judged") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(status!.job.status, "Judged");
    const names = status!.steps.map((s) => s.name);
    for (const n of ["job posted", "agent registered", "bond posted", "job accepted", "patch delivered"]) assert.ok(names.includes(n), `missing step ${n}: ${names}`);

    const verdict = await call(`/receipts/${job_id}/verdict.json`);
    assert.equal(verdict.status, 200);
    assert.equal(((await verdict.json()) as { checks_passed: number }).checks_passed, 2);
    assert.equal((await call(`/receipts/${job_id}/..%2F..%2Fpackage.json`)).status, 400);
    assert.equal((await call(`/receipts/${job_id}/secret.txt`)).status, 400);
    assert.equal((await call("/demo/status/999")).status, 404);

    // Wait for the background run to finish, then the hourly limit (2) applies.
    for (let i = 0; i < 50 && demo.isBusy(); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal((await post({ scenario: "honest" })).status, 202);
    for (let i = 0; i < 100 && demo.isBusy(); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal((await post({ scenario: "honest" })).status, 429, "hourly limit");
  } finally {
    server.close();
    await w.cleanup();
  }
});

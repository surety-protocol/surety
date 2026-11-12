// npm run mock:data -w @surety/web
//
// Builds the dashboard's mock-mode data by running a small scenario on MockChain
// (the shared in-memory copy of the contract rules). Every amount, premium and
// settlement in mock mode is therefore what the real contract would produce.
// Output: web/src/mock/fixture.json

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "@surety/shared/hash";
import { MockChain } from "@surety/shared/mock-chain";
import { scoreBps } from "@surety/shared/pricing";
import type { AiVote, CheckResult, JobSpec, Verdict } from "@surety/shared/types";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const spec = JSON.parse(readFileSync(join(root, "agents", "jobs", "login-bug.json"), "utf8")) as JobSpec;
const MODELS = ["deepseek-ai/DeepSeek-V4.1-Flash-1017", "z-ai/glm-5.3-flash", "Qwen/Qwen3.8-27B"];
const T = (n: number) => String(BigInt(n) * 1_000_000n);
const MIN = 60_000;

const chain = new MockChain({ judgeId: "judge.surety.testnet", panelId: "panel.surety.testnet" });
const judge = chain.as(chain.judgeId);
const agents = ["atlas.testnet", "forge.testnet", "nova.testnet", "drift.testnet", "vex.testnet"];
const bonds = [500, 300, 400, 150, 120];
const clients = ["alice.testnet", "bob.testnet", "carol.testnet", "dave.testnet", "erin.testnet", "frank.testnet"];
const backers = ["backer1.testnet", "backer2.testnet", "backer3.testnet"];

for (const [i, a] of agents.entries()) {
  chain.mint(a, T(bonds[i]!));
  await chain.as(a).registerAgent();
  await chain.as(a).depositBond(T(bonds[i]!));
  chain.advance(7 * MIN);
}
for (const c of clients) chain.mint(c, T(10_000));
for (const b of backers) chain.mint(b, T(1_000));
await chain.as("backer1.testnet").depositPool("atlas.testnet", T(600));
await chain.as("backer2.testnet").depositPool("atlas.testnet", T(300));
await chain.as("backer3.testnet").depositPool("nova.testnet", T(500));

const verdicts: Record<number, Verdict> = {};
let n = 0;

function makeVerdict(jobId: number, patchHash: string, passedIds: Set<string>, now: number): Verdict {
  const checks: CheckResult[] = spec.checks.map((c) => {
    const pass = passedIds.has(c.id);
    if (c.type === "test") return { id: c.id, type: "test", name: c.name, pass };
    // On failed AI checks one model dissents; the majority decides.
    const votes: AiVote[] = MODELS.map((model, i) => {
      const vote = i === 2 && !pass ? true : pass;
      return {
      model,
      pass: vote,
      reason: vote
        ? "The diff stays inside src/auth/ and addresses the empty-password case."
        : "The patch also changes session token length and the lockout counter, which the spec did not ask for.",
      attestation_verified: true,
      signature_verified: true,
      problems: [],
      };
    });
    return { id: c.id, type: "ai", question: c.question, pass, votes };
  });
  const passed = checks.filter((c) => c.pass).length;
  return {
    job_id: jobId,
    spec_hash: sha256Hex(JSON.stringify(spec)),
    patch_hash: patchHash,
    checks,
    checks_passed: passed,
    checks_total: checks.length,
    score_bps: scoreBps(passed, checks.length),
    isolation: "docker",
    problems: [],
    judged_at_ms: now,
  };
}

/** Run one job as far as `until`, judged with `passed` check ids. */
async function job(client: string, agent: string | null, value: number, passed: string[], until: "Open" | "Accepted" | "Delivered" | "Judged" | "Settled") {
  n++;
  const deadline = (await chain.now()) + 24 * 60 * MIN;
  const { value: id } = await chain.as(client).postJob({
    value: T(value),
    spec_hash: sha256Hex(JSON.stringify(spec)),
    spec_url: `https://github.com/surety-protocol/surety/blob/main/agents/jobs/login-bug.json`,
    deadline_ms: deadline,
  });
  chain.advance(2 * MIN);
  if (until === "Open" || !agent) return id;
  await chain.as(agent).acceptJob(id);
  chain.advance(3 * MIN);
  if (until === "Accepted") return id;
  const patchHash = sha256Hex(`patch-${n}`);
  await chain.as(agent).deliver(id, `https://github.com/surety-protocol/surety/tree/main/agents/patches#job-${id}`, patchHash);
  chain.advance(MIN);
  if (until === "Delivered") return id;
  const v = makeVerdict(id, patchHash, new Set(passed), await chain.now());
  verdicts[id] = v;
  await judge.submitVerdict({
    job_id: id,
    score_bps: v.score_bps,
    checks_passed: v.checks_passed,
    checks_total: v.checks_total,
    receipts_hash: sha256Hex(JSON.stringify(v, null, 2) + "\n"),
  });
  if (until === "Judged") return id;
  chain.advance(chain.config.appeal_window_ms + 1);
  await judge.settle(id);
  chain.advance(10 * MIN);
  return id;
}

const ALL = spec.checks.map((c) => c.id);
const SLOPPY = ["t1", "t2", "t4", "t5", "a1"]; // 5/7: partial
const CHEAT = ["t1", "t2", "t3", "t4", "t5"]; // tests pass, AI checks catch the rewrite: 5/7
const BAD = ["t2", "a1"]; // 2/7: fail

await job("alice.testnet", "atlas.testnet", 100, ALL, "Settled");
await job("bob.testnet", "forge.testnet", 200, BAD, "Settled");
await job("carol.testnet", "nova.testnet", 80, ALL, "Settled");
await job("dave.testnet", "drift.testnet", 50, SLOPPY, "Settled");
await job("erin.testnet", "vex.testnet", 60, BAD, "Settled");
await job("frank.testnet", "atlas.testnet", 120, ALL, "Settled");
await job("alice.testnet", "forge.testnet", 90, CHEAT, "Settled");
await job("bob.testnet", "nova.testnet", 70, ALL, "Settled");
await job("carol.testnet", "atlas.testnet", 150, ALL, "Settled");
await job("dave.testnet", "vex.testnet", 40, BAD, "Settled");
await job("erin.testnet", "drift.testnet", 50, ALL, "Judged");
await job("frank.testnet", "nova.testnet", 60, [], "Delivered");
await job("alice.testnet", "atlas.testnet", 75, [], "Accepted");
await job("bob.testnet", null, 45, [], "Open");
// An open job nobody took, cancelled after its deadline: the client is refunded.
const lapsed = await job("carol.testnet", null, 30, [], "Open");
chain.advance(25 * 60 * MIN);
await chain.as("carol.testnet").cancelExpired(lapsed);
chain.checkInvariant();

const fixture = {
  generated_by: "web/scripts/make-mock.ts (MockChain)",
  now_ms: await chain.now(),
  agents: await chain.listAgents(0, 100),
  jobs: await chain.listJobs(0, 100),
  verdicts,
};
writeFileSync(join(here, "..", "src", "mock", "fixture.json"), JSON.stringify(fixture, null, 2) + "\n");
console.log(`wrote ${fixture.agents.length} agents, ${fixture.jobs.length} jobs, ${Object.keys(verdicts).length} verdicts`);

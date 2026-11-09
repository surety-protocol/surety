import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "@surety/shared/env";
import { MockChain } from "@surety/shared/mock-chain";
import { postJob, runAgent, SCENARIOS } from "../src/agent.ts";

test("every scenario's spec and patch exist and are LF-only (stable hashes on every OS)", () => {
  for (const s of Object.values(SCENARIOS)) {
    for (const f of [s.spec, s.patch]) {
      assert.ok(existsSync(join(REPO_ROOT, f)), f);
      assert.ok(!readFileSync(join(REPO_ROOT, f), "utf8").includes("\r\n"), `${f} has CRLF line endings`);
    }
  }
});

test("runAgent registers, bonds, accepts and delivers with the right hash", async () => {
  const c = new MockChain({ judgeId: "j", panelId: "p" });
  c.mint("client", "1000000000");
  c.mint("agent", "1000000000");
  const id = await postJob({ chain: c, clientId: "client", repoRoot: REPO_ROOT, specRef: SCENARIOS.honest.spec, value: "50000000", deadlineMs: (await c.now()) + 1e6 });
  const steps: string[] = [];
  await runAgent({ chain: c, agentId: "agent", jobId: id, repoRoot: REPO_ROOT, patchRef: SCENARIOS.honest.patch, log: (s) => steps.push(s) });
  assert.deepEqual(steps, ["agent registered", "bond posted", "job accepted", "patch delivered"]);
  const job = (await c.getJob(id))!;
  assert.equal(job.status, "Delivered");
  assert.equal(job.patch_url, SCENARIOS.honest.patch);
  assert.equal((await c.getAgent("agent"))!.bond, "100000000");
});

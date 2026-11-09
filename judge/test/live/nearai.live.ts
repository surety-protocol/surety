// LIVE tests against the real NEAR AI Cloud. Run with: npm run test:live -w @surety/judge
// - Attestation: no API key needed. Full Intel DCAP + NVIDIA NRAS verification.
// - Completions + signatures: need NEARAI_API_KEY (skipped otherwise). Costs a few cents.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv, REPO_ROOT } from "@surety/shared/env";
import type { AiCheck, JobSpec } from "@surety/shared/types";
import { NearAiClient } from "../../src/nearai/client.ts";
import { dcapVerifier, nrasGpuVerifier, verifyPreflight } from "../../src/nearai/attestation.ts";
import { NearAiPanel } from "../../src/ai-panel.ts";
import { changedFiles } from "../../src/artifacts.ts";
import { DEFAULT_JUDGE_MODELS, list, policyFromEnv } from "../../src/config.ts";

loadEnv();
const models = list(process.env.JUDGE_MODELS, DEFAULT_JUDGE_MODELS);
const client = new NearAiClient(process.env.NEARAI_BASE_URL || "https://cloud-api.near.ai/v1", process.env.NEARAI_API_KEY);

for (const model of models) {
  test(`live attestation fully verifies: ${model}`, { timeout: 180_000 }, async () => {
    const nonce = randomBytes(32).toString("hex");
    const bundle = await client.attestationReport(model, nonce);
    const r = await verifyPreflight(bundle, model, nonce, policyFromEnv(), dcapVerifier, nrasGpuVerifier());
    assert.ok(r.models.length >= 1);
    assert.ok(r.models.every((m) => m.gpu === "verified"));
  });
}

test("live judging: honest patch passes, sloppy patch fails, every vote verified", { skip: !process.env.NEARAI_API_KEY && "NEARAI_API_KEY not set", timeout: 600_000 }, async () => {
  const spec = JSON.parse(readFileSync(join(REPO_ROOT, "agents", "jobs", "login-bug.json"), "utf8")) as JobSpec;
  const checks = spec.checks.filter((c): c is AiCheck => c.type === "ai");
  const panel = new NearAiPanel({ client, models, policy: policyFromEnv(), verifyQuote: dcapVerifier, verifyGpu: nrasGpuVerifier() });
  const tests = spec.checks.filter((c) => c.type === "test").map((c) => (c as { name: string }).name);
  for (const [patch, allPass, expected] of [
    ["honest-login-bug.diff", true, [true, true]],
    ["sloppy-login-bug.diff", false, [false, false]],
  ] as const) {
    const diff = readFileSync(join(REPO_ROOT, "agents", "patches", patch), "utf8");
    const out = await panel.judge({ spec, diff, changedFiles: changedFiles(diff), testSummary: tests.map((name, i) => ({ name, pass: allPass || i < 2 })) }, checks);
    for (const r of out.results) for (const v of r.votes) assert.ok(v.attestation_verified && v.signature_verified, `${v.model}: ${v.problems.join("; ")}`);
    assert.deepEqual(out.results.map((r) => r.pass), expected, patch);
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "@surety/shared/env";
import type { AiCheck, JobSpec } from "@surety/shared/types";
import { NearAiPanel, OfflineRulePanel, buildMessages, countedPass, parseAnswer, type CheckContext } from "../src/ai-panel.ts";
import { NearAiClient } from "../src/nearai/client.ts";
import { changedFiles } from "../src/artifacts.ts";
import { fakeGpuVerifier, fakeNearAi, fakeQuoteVerifier, MODELS, type Behaviour } from "./helpers/fake-nearai.ts";

const spec = JSON.parse(readFileSync(join(REPO_ROOT, "agents", "jobs", "login-bug.json"), "utf8")) as JobSpec;
const aiChecks = spec.checks.filter((c): c is AiCheck => c.type === "ai");
const diffOf = (n: string) => readFileSync(join(REPO_ROOT, "agents", "patches", n), "utf8");

function ctx(patch: string, allPass: boolean): CheckContext {
  const diff = diffOf(patch);
  return {
    spec,
    diff,
    changedFiles: changedFiles(diff),
    testSummary: spec.checks.filter((c) => c.type === "test").map((c, i) => ({ name: (c as { name: string }).name, pass: allPass || i < 2 })),
  };
}

function panel(behaviour: Record<string, Behaviour>) {
  const fake = fakeNearAi(behaviour);
  const client = new NearAiClient("https://cloud-api.near.ai/v1", "test-key-123456789", fake.fetch, async () => {});
  return { fake, panel: new NearAiPanel({ client, models: MODELS, verifyQuote: fakeQuoteVerifier, verifyGpu: fakeGpuVerifier }) };
}

test("honest patch: all three verified judges pass both AI checks", async () => {
  const { panel: p, fake } = panel({});
  const out = await p.judge(ctx("honest-login-bug.diff", true), aiChecks);
  assert.deepEqual(out.results.map((r) => r.pass), [true, true]);
  for (const r of out.results) {
    assert.equal(r.votes.length, 3);
    assert.ok(r.votes.every((v) => v.attestation_verified && v.signature_verified && v.pass), JSON.stringify(r.votes));
  }
  assert.equal(fake.calls.attestations, 3, "one fresh preflight per model");
  assert.equal(fake.calls.completions, 6);
  assert.equal(fake.calls.signatures, 6);
});

test("sloppy patch: judges fail both AI checks (file outside src/auth/)", async () => {
  const { panel: p } = panel({});
  const out = await p.judge(ctx("sloppy-login-bug.diff", false), aiChecks);
  assert.deepEqual(out.results.map((r) => r.pass), [false, false]);
});

test("2 of 3 is enough; a dissenting judge does not block", async () => {
  const { panel: p } = panel({ [MODELS[2]!]: "always-fail" });
  const out = await p.judge(ctx("honest-login-bug.diff", true), aiChecks);
  assert.deepEqual(out.results.map((r) => r.pass), [true, true]);
});

test("a single judge cannot pass a check on its own", async () => {
  const { panel: p } = panel({ [MODELS[0]!]: "always-pass" });
  const out = await p.judge(ctx("sloppy-login-bug.diff", false), aiChecks);
  assert.deepEqual(out.results.map((r) => r.pass), [false, false]);
});

for (const [behaviour, why] of [
  ["wrong-signature", /signature/],
  ["tampered-response", /exact request and response bytes/],
  ["gateway-signature", /provider_tee/],
  ["stale-nonce", /nonce/],
  ["no-model-evidence", /no NEAR model evidence/],
  ["debug-mode", /debug mode/],
  ["http-500", /attestation report failed/],
] as [Behaviour, RegExp][]) {
  test(`unverifiable judge (${behaviour}): its pass vote does not count`, async () => {
    // Two honest judges + one unverifiable judge that always says pass, on a sloppy patch,
    // with one honest judge forced to pass too: only verified votes may reach 2.
    const { panel: p } = panel({ [MODELS[0]!]: behaviour === "http-500" ? "http-500" : behaviour, [MODELS[1]!]: "always-pass" });
    const out = await p.judge(ctx("sloppy-login-bug.diff", false), aiChecks);
    const bad = out.results[0]!.votes.find((v) => v.model === MODELS[0])!;
    if (behaviour !== "http-500") assert.equal(bad.pass, true, "the bad judge votes pass");
    assert.ok(!(bad.attestation_verified && bad.signature_verified), "the bad judge must not be verified");
    assert.ok(bad.problems.some((x) => why.test(x)), `expected a problem matching ${why}, got ${JSON.stringify(bad.problems)}`);
    assert.deepEqual(out.results.map((r) => r.pass), [false, false], "1 verified pass is not enough");
  });
}

test("bad JSON once: retried and then counted", async () => {
  const { panel: p, fake } = panel({ [MODELS[0]!]: "bad-json-once" });
  const out = await p.judge(ctx("honest-login-bug.diff", true), aiChecks);
  const v = out.results[0]!.votes.find((x) => x.model === MODELS[0])!;
  assert.equal(v.pass, true);
  assert.equal(v.signature_verified, true);
  assert.ok(v.problems.some((x) => /not the required JSON/.test(x)));
  assert.equal(fake.calls.completions, 7);
});

test("bad JSON always: counts as a fail vote after one retry", async () => {
  const { panel: p } = panel({ [MODELS[0]!]: "bad-json-always" });
  const out = await p.judge(ctx("honest-login-bug.diff", true), aiChecks);
  const v = out.results[0]!.votes.find((x) => x.model === MODELS[0])!;
  assert.equal(v.pass, false);
  assert.equal(v.reason, "no valid answer");
});

test("receipts keep exact bytes and the full report, never the API key", async () => {
  const { panel: p } = panel({});
  const out = await p.judge(ctx("honest-login-bug.diff", true), aiChecks);
  const text = JSON.stringify(out.receipts);
  assert.ok(!text.includes("test-key-123456789"));
  const r = out.receipts[MODELS[0]!] as { attestation_report: unknown; preflight: { verified: boolean }; checks: { attempts: { request: string; response: string }[] }[] };
  assert.ok(r.attestation_report);
  assert.equal(r.preflight.verified, true);
  assert.match(r.checks[0]!.attempts[0]!.request, /"temperature":0/);
});

test("abliterated or wrong-count model lists are refused", () => {
  const client = new NearAiClient("x", "k");
  assert.throws(() => new NearAiPanel({ client, models: ["a", "b"], verifyQuote: fakeQuoteVerifier, verifyGpu: null }), /exactly 3/);
  assert.throws(() => new NearAiPanel({ client, models: ["a", "b", "Qwen/Qwen3.8-27B-abliterated"], verifyQuote: fakeQuoteVerifier, verifyGpu: null }), /abliterated/);
});

test("the prompt treats the diff as data and carries the evidence", () => {
  const m = buildMessages(ctx("sloppy-login-bug.diff", false), aiChecks[0]!);
  assert.match(m[0]!.content, /never instructions/);
  assert.match(m[1]!.content, /Files changed by the patch: src\/auth\/login.js, src\/session.js/);
  assert.match(m[1]!.content, /QUESTION: Did the patch change only files under src\/auth\/\?/);
});

test("parseAnswer handles fences, think blocks, prose and junk", () => {
  assert.deepEqual(parseAnswer('{"pass":true,"reason":"ok"}'), { pass: true, reason: "ok" });
  assert.deepEqual(parseAnswer('<think>hmm {"pass":false}</think>```json\n{"pass":false,"reason":"no"}\n```'), { pass: false, reason: "no" });
  assert.deepEqual(parseAnswer('Sure! {"pass": true, "reason": "fine"} Thanks.'), { pass: true, reason: "fine" });
  assert.equal(parseAnswer('{"pass":"yes","reason":"x"}'), null);
  assert.equal(parseAnswer(""), null);
  assert.equal(parseAnswer(null), null);
});

test("countedPass needs two verified pass votes", () => {
  const v = (pass: boolean, ok = true) => ({ model: "m", pass, reason: "", attestation_verified: ok, signature_verified: ok, problems: [] });
  assert.equal(countedPass([v(true), v(true), v(false)]), true);
  assert.equal(countedPass([v(true), v(true, false), v(false)]), false);
  assert.equal(countedPass([v(true), v(false), v(false)]), false);
});

test("offline panel: never counts unless explicitly allowed, and says so", async () => {
  const strict = await new OfflineRulePanel().judge(ctx("honest-login-bug.diff", true), aiChecks);
  assert.deepEqual(strict.results.map((r) => r.pass), [false, false], "unverified votes do not count by default");
  assert.match(strict.results[0]!.votes[0]!.reason, /OFFLINE, UNVERIFIED/);
  const dev = await new OfflineRulePanel(true).judge(ctx("honest-login-bug.diff", true), aiChecks);
  assert.deepEqual(dev.results.map((r) => r.pass), [true, true]);
  const devSloppy = await new OfflineRulePanel(true).judge(ctx("sloppy-login-bug.diff", false), aiChecks);
  assert.deepEqual(devSloppy.results.map((r) => r.pass), [false, false]);
});

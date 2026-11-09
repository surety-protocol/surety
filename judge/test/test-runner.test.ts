import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "@surety/shared/env";
import { parseTap, patchProblems, runTests, sandboxEnv, testOutcomes } from "../src/test-runner.ts";

const repoDir = join(REPO_ROOT, "agents", "demo-repo");
const patch = (name: string) => readFileSync(join(REPO_ROOT, "agents", "patches", name));
const NAMES = ["rejects empty password", "accepts valid password", "returns EMPTY_PASSWORD code", "locks after 5 failed attempts", "existing session tests still pass"];

test("honest patch passes all 5 tests (real run)", async () => {
  const r = await runTests({ repoDir, patch: patch("honest-login-bug.diff"), testCommand: "npm test --silent" });
  assert.equal(r.applied, true, r.applyError ?? "");
  assert.equal(r.isolation, "tempdir");
  const o = testOutcomes(NAMES, r);
  assert.deepEqual(o.map((x) => x.pass), [true, true, true, true, true], r.output);
});

test("sloppy patch passes only 2 of 5 tests (real run)", async () => {
  const r = await runTests({ repoDir, patch: patch("sloppy-login-bug.diff"), testCommand: "npm test --silent" });
  assert.equal(r.applied, true, r.applyError ?? "");
  const o = testOutcomes(NAMES, r);
  assert.deepEqual(o.map((x) => x.pass), [true, true, false, false, false], r.output);
});

test("the original repo is never modified", async () => {
  const before = readFileSync(join(repoDir, "src", "auth", "login.js"), "utf8");
  await runTests({ repoDir, patch: patch("honest-login-bug.diff"), testCommand: "npm test --silent" });
  assert.equal(readFileSync(join(repoDir, "src", "auth", "login.js"), "utf8"), before);
});

test("a patch that does not apply fails every test", async () => {
  const bad = Buffer.from("diff --git a/src/nope.js b/src/nope.js\n--- a/src/nope.js\n+++ b/src/nope.js\n@@ -1 +1 @@\n-x\n+y\n");
  const r = await runTests({ repoDir, patch: bad, testCommand: "npm test --silent" });
  assert.equal(r.applied, false);
  assert.ok(r.applyError);
  assert.ok(testOutcomes(NAMES, r).every((x) => !x.pass));
});

test("unsafe patches are refused before anything runs", async () => {
  assert.deepEqual(patchProblems("diff --git a/../../etc/x b/../../etc/x\n"), ["unsafe path in patch: ../../etc/x"]);
  assert.ok(patchProblems("diff --git a/l b/l\nnew file mode 120000\n").includes("patch creates a symbolic link"));
  assert.ok(patchProblems("GIT binary patch\n").length > 0);
  const r = await runTests({ repoDir, patch: Buffer.from("--- /etc/passwd\n+++ /etc/passwd\n"), testCommand: "npm test --silent" });
  assert.equal(r.applied, false);
  assert.match(r.applyError!, /unsafe path/);
});

test("a patch that hangs is killed by the timeout", async () => {
  const hang = Buffer.from(
    [
      "diff --git a/test/hang.test.js b/test/hang.test.js",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/test/hang.test.js",
      "@@ -0,0 +1,2 @@",
      '+import { test } from "node:test";',
      '+test("hang", () => new Promise(() => setInterval(() => {}, 1000)));',
      "",
    ].join("\n"),
  );
  const t0 = Date.now();
  const r = await runTests({ repoDir, patch: hang, testCommand: "npm test --silent", timeoutMs: 4000 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 30_000);
  assert.ok(testOutcomes(NAMES, r).every((x) => !x.pass), "a timed-out run passes nothing");
});

test("untrusted code never sees secrets", async () => {
  process.env.NEARAI_API_KEY = "sk-secret";
  process.env.JUDGE_PRIVATE_KEY = "ed25519:secret";
  const env = sandboxEnv();
  assert.equal(env.NEARAI_API_KEY, undefined);
  assert.equal(env.JUDGE_PRIVATE_KEY, undefined);
  // And for real: a patch that tries to read them.
  const leak = Buffer.from(
    [
      "diff --git a/test/leak.test.js b/test/leak.test.js",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/test/leak.test.js",
      "@@ -0,0 +1,3 @@",
      '+import { test } from "node:test";',
      '+import assert from "node:assert";',
      '+test("no secrets", () => { assert.equal(process.env.NEARAI_API_KEY, undefined); assert.equal(process.env.JUDGE_PRIVATE_KEY, undefined); });',
      "",
    ].join("\n"),
  );
  const r = await runTests({ repoDir, patch: leak, testCommand: "npm test --silent" });
  assert.equal(r.tests.get("no secrets"), true, r.output);
});

test("TAP parsing: pass, fail, skip, todo, nested, escapes", () => {
  const tap = [
    "TAP version 13",
    "ok 1 - alpha",
    "not ok 2 - beta",
    "ok 3 - gamma # SKIP not today",
    "ok 4 - delta # TODO later",
    "    ok 1 - nested child",
    "ok 5 - has \\# hash",
    "not ok 6 - alpha",
  ].join("\n");
  const m = parseTap(tap);
  assert.equal(m.get("alpha"), false, "a name that fails anywhere counts as failed");
  assert.equal(m.get("beta"), false);
  assert.equal(m.get("gamma"), false, "skipped is not passed");
  assert.equal(m.get("delta"), false, "todo is not passed");
  assert.equal(m.get("nested child"), true);
  assert.equal(m.get("has # hash"), true);
});

test("a test name missing from the output fails and is marked not found", () => {
  const o = testOutcomes(["missing"], { applied: true, isolation: "tempdir", exitCode: 0, timedOut: false, output: "", tests: new Map() });
  assert.deepEqual(o, [{ name: "missing", pass: false, found: false }]);
});

// Applies an untrusted patch to a throwaway copy of the job's repo and runs the
// tests. The patched code is untrusted: it gets a fresh temp folder, a short
// timeout, capped output and an environment with NO secrets. With JUDGE_DOCKER=1
// it runs inside a container with no network instead.

import { spawn } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TestOutcome {
  name: string;
  pass: boolean;
  found: boolean;
}

export interface RunResult {
  applied: boolean;
  applyError?: string;
  isolation: "docker" | "tempdir";
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  tests: Map<string, boolean>;
}

const MAX_OUTPUT = 1_000_000;

/** Environment for untrusted code: only what node/npm need to start. Never API keys or wallet keys. */
export function sandboxEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC", "PATHEXT", "TEMP", "TMP", "WINDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"];
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", CI: "1", npm_config_update_notifier: "false", npm_config_fund: "false" };
  for (const k of keep) if (base[k] !== undefined) env[k] = base[k];
  return env;
}

/** Parse TAP from `node --test --test-reporter=tap`. A name that fails anywhere counts as failed. */
export function parseTap(output: string): Map<string, boolean> {
  const results = new Map<string, boolean>();
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*(not )?ok \d+ - (.*?)(\s+#\s*(SKIP|TODO)\b.*)?$/i.exec(line);
    if (!m) continue;
    const name = m[2]!.replace(/\\#/g, "#").replace(/\\\\/g, "\\").trim();
    const pass = !m[1] && !m[3];
    results.set(name, (results.get(name) ?? true) && pass);
  }
  return results;
}

/** How long to wait for output pipes to close after a kill before giving up on them. */
const KILL_GRACE_MS = 5_000;

/** Kill the process AND everything it started (npm starts node, node starts test workers). */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }).on("error", () => {});
    return;
  }
  try {
    process.kill(-pid, "SIGKILL"); // the whole process group (child was spawned detached)
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number, input?: string): Promise<{ code: number | null; out: string; timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    // detached on POSIX = own process group, so a timeout can kill grandchildren too.
    const child = spawn(cmd, args, { cwd, env: sandboxEnv(), shell: false, windowsHide: true, detached: process.platform !== "win32" });
    let out = "";
    let timedOut = false;
    let settled = false;
    let grace: NodeJS.Timeout | undefined;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      child.stdout.destroy();
      child.stderr.destroy();
      resolvePromise({ code, out: out.slice(0, MAX_OUTPUT), timedOut });
    };
    const add = (b: Buffer) => {
      if (out.length < MAX_OUTPUT) out += b.toString("utf8");
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      // If a process survives and holds the pipes open, never wait forever.
      grace = setTimeout(() => {
        out += "\n[judge] output pipes still open after kill; abandoned";
        finish(null);
      }, KILL_GRACE_MS);
    }, timeoutMs);
    child.on("error", (e) => {
      out += `\n[spawn error] ${e.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** Refuse patch features that could reach outside the copy. */
export function patchProblems(patch: string): string[] {
  const problems: string[] = [];
  if (/^(new|old)? ?(file )?mode 120000/m.test(patch)) problems.push("patch creates a symbolic link");
  if (/^GIT binary patch/m.test(patch)) problems.push("binary patches are not accepted");
  for (const m of patch.matchAll(/^(?:diff --git a\/(\S+) b\/(\S+)|(?:---|\+\+\+) (?:[ab]\/)?(\S+))/gm)) {
    for (const p of [m[1], m[2], m[3]]) {
      if (p && p !== "/dev/null" && (p.startsWith("/") || p.split("/").includes(".."))) problems.push(`unsafe path in patch: ${p}`);
    }
  }
  return [...new Set(problems)];
}

export interface RunTestsArgs {
  repoDir: string;
  patch: Buffer;
  /** Already validated against ALLOWED_TEST_COMMANDS. */
  testCommand: string;
  timeoutMs?: number;
  useDocker?: boolean;
}

export async function runTests(a: RunTestsArgs): Promise<RunResult> {
  const timeoutMs = a.timeoutMs ?? 120_000;
  const work = await mkdtemp(join(tmpdir(), "surety-judge-"));
  const isolation: "docker" | "tempdir" = a.useDocker ? "docker" : "tempdir";
  const base = { isolation, tests: new Map<string, boolean>(), exitCode: null, timedOut: false, output: "" };
  try {
    const problems = patchProblems(a.patch.toString("utf8"));
    if (problems.length) return { ...base, applied: false, applyError: problems.join("; ") };

    const repo = join(work, "repo");
    await cp(a.repoDir, repo, { recursive: true, filter: (src) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(src) });
    const patchFile = join(work, "change.diff");
    await writeFile(patchFile, a.patch);

    const check = await run("git", ["apply", "--check", "--whitespace=nowarn", patchFile], repo, 30_000);
    if (check.code !== 0) return { ...base, applied: false, applyError: check.out.trim() || "git apply --check failed" };
    const apply = await run("git", ["apply", "--whitespace=nowarn", patchFile], repo, 30_000);
    if (apply.code !== 0) return { ...base, applied: false, applyError: apply.out.trim() || "git apply failed" };

    const [cmd, ...args] = a.testCommand.split(" ");
    const res = a.useDocker
      ? await run("docker", ["run", "--rm", "--network", "none", "--memory", "512m", "--cpus", "1", "-v", `${repo}:/work`, "-w", "/work", "node:24-alpine", "sh", "-c", a.testCommand], work, timeoutMs)
      : process.platform === "win32"
        ? // npm is a .cmd on Windows and needs cmd.exe; the command is one of the fixed allowed strings.
          await run("cmd.exe", ["/d", "/s", "/c", a.testCommand], repo, timeoutMs)
        : await run(cmd!, args, repo, timeoutMs);
    return {
      ...base,
      applied: true,
      exitCode: res.code,
      timedOut: res.timedOut,
      output: res.out,
      tests: parseTap(res.out),
    };
  } finally {
    await rm(work, { recursive: true, force: true, maxRetries: 3 });
  }
}

export function testOutcomes(names: string[], result: RunResult): TestOutcome[] {
  return names.map((name) => {
    const r = result.tests.get(name);
    return { name, pass: result.applied && !result.timedOut && r === true, found: r !== undefined };
  });
}

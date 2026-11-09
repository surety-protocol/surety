import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scoreBps } from "@surety/shared/pricing";
import { sha256Hex } from "@surety/shared/hash";
import type { CheckResult, JobSpec, Verdict } from "@surety/shared/types";
import type { AiCheckResult } from "./ai-panel.ts";
import type { TestOutcome } from "./test-runner.ts";

export function buildVerdict(a: {
  jobId: number;
  specHash: string;
  patchHash: string;
  spec: JobSpec | null;
  tests: TestOutcome[];
  ai: AiCheckResult[];
  isolation: "docker" | "tempdir";
  problems: string[];
  nowMs: number;
}): Verdict {
  let checks: CheckResult[];
  if (!a.spec) {
    // Spec unusable: one failed placeholder check, so the score is 0 and the reason is on record.
    checks = [{ id: "spec", type: "test", name: "job spec could be loaded and verified", pass: false }];
  } else {
    checks = a.spec.checks.map((c): CheckResult => {
      if (c.type === "test") {
        const t = a.tests.find((x) => x.name === c.name);
        return { id: c.id, type: "test", name: c.name, pass: t?.pass ?? false };
      }
      const r = a.ai.find((x) => x.check.id === c.id);
      return { id: c.id, type: "ai", question: c.question, pass: r?.pass ?? false, votes: r?.votes ?? [] };
    });
  }
  const passed = checks.filter((c) => c.pass).length;
  return {
    job_id: a.jobId,
    spec_hash: a.specHash,
    patch_hash: a.patchHash,
    checks,
    checks_passed: passed,
    checks_total: checks.length,
    score_bps: scoreBps(passed, checks.length),
    isolation: a.isolation,
    problems: a.problems,
    judged_at_ms: a.nowMs,
  };
}

/** The exact bytes hashed on-chain as receipts_hash. */
export function verdictBytes(v: Verdict): Buffer {
  return Buffer.from(JSON.stringify(v, null, 2) + "\n", "utf8");
}

/** Throws if any secret value appears anywhere in the receipt text. */
export function assertNoSecrets(text: string, secrets: (string | undefined)[]): void {
  for (const s of secrets) {
    if (s && s.length >= 8 && text.includes(s)) throw new Error("refusing to write a receipt that contains a secret");
  }
  if (/"authorization"\s*:/i.test(text) || /Bearer\s+[A-Za-z0-9._-]{12,}/.test(text)) {
    throw new Error("refusing to write a receipt that contains an authorization header");
  }
}

const safeName = (model: string) => model.replace(/[^A-Za-z0-9._-]+/g, "_");

/** Write receipts/<job>/{verdict,tests,judge-*}.json atomically. Returns receipts_hash. */
export async function writeReceipts(a: {
  receiptsDir: string;
  verdict: Verdict;
  tests: unknown;
  judges: Record<string, unknown>;
  secrets: (string | undefined)[];
}): Promise<{ dir: string; receiptsHash: string }> {
  const final = join(a.receiptsDir, String(a.verdict.job_id));
  const tmp = `${final}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(tmp, { recursive: true });
  const files: [string, Buffer][] = [
    ["verdict.json", verdictBytes(a.verdict)],
    ["tests.json", Buffer.from(JSON.stringify(a.tests, null, 2) + "\n")],
    ...Object.entries(a.judges).map(([m, r]): [string, Buffer] => [`judge-${safeName(m)}.json`, Buffer.from(JSON.stringify(r, null, 2) + "\n")]),
  ];
  for (const [, b] of files) assertNoSecrets(b.toString("utf8"), a.secrets);
  for (const [name, b] of files) await writeFile(join(tmp, name), b);
  // A retry after a failed submit replaces the earlier receipts for this job.
  await rm(final, { recursive: true, force: true });
  await rename(tmp, final);
  return { dir: final, receiptsHash: sha256Hex(files[0]![1]) };
}

// Watches the contract for delivered jobs, judges them, submits verdicts and
// settles jobs whose appeal window has closed.

import type { SuretyChain } from "@surety/shared/chain";
import type { AiCheck, JobView, Verdict } from "@surety/shared/types";
import { changedFiles, loadPatch, loadSpec, resolveInRepo, type Fetcher, type LoadedSpec } from "./artifacts.ts";
import type { AiCheckResult, AiPanel } from "./ai-panel.ts";
import { runTests, testOutcomes, type RunResult, type TestOutcome } from "./test-runner.ts";
import { buildVerdict, writeReceipts } from "./verdict.ts";

export interface WorkerOptions {
  chain: SuretyChain;
  judgeId: string;
  repoRoot: string;
  receiptsDir: string;
  panel: AiPanel;
  useDocker?: boolean;
  testTimeoutMs?: number;
  /** Values that must never appear in receipts. */
  secrets?: (string | undefined)[];
  fetcher?: Fetcher;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /** Called after each step, for the demo progress panel. */
  onStep?: (jobId: number, step: string, detail?: string) => void;
}

export interface JudgeResult {
  verdict: Verdict;
  receiptsHash: string;
  receiptsDir: string;
  tx: string;
}

export class JudgeWorker {
  private readonly judging = new Map<number, Promise<JudgeResult>>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(private readonly o: WorkerOptions) {}

  private log(msg: string, extra?: Record<string, unknown>) {
    (this.o.log ?? ((m, e) => console.log(`[judge] ${m}`, e ?? "")))(msg, extra);
  }

  private step(jobId: number, step: string, detail?: string) {
    this.o.onStep?.(jobId, step, detail);
  }

  /**
   * Judge one delivered job end to end and submit the verdict. Safe to call from
   * several places at once (the poll loop and the demo runner): each job is judged
   * exactly once, and concurrent callers share the same result.
   */
  processJob(job: JobView): Promise<JudgeResult> {
    const existing = this.judging.get(job.job_id);
    if (existing) return existing;
    const p = this.judgeOnce(job).catch((e) => {
      this.judging.delete(job.job_id); // allow a retry on the next tick
      throw e;
    });
    this.judging.set(job.job_id, p);
    return p;
  }

  private async judgeOnce(job: JobView): Promise<JudgeResult> {
    if (job.status !== "Delivered") throw new Error(`job ${job.job_id} is ${job.status}, not Delivered`);
    const problems: string[] = [];
    let loaded: LoadedSpec | null = null;
    let patch: Buffer | null = null;

    this.step(job.job_id, "loading spec and patch");
    try {
      loaded = await loadSpec(job.spec_url, job.spec_hash, this.o.repoRoot, this.o.fetcher);
    } catch (e) {
      problems.push(`spec: ${(e as Error).message}`);
    }
    try {
      patch = (await loadPatch(job.patch_url!, job.patch_hash!, this.o.repoRoot, this.o.fetcher)).bytes;
    } catch (e) {
      problems.push(`patch: ${(e as Error).message}`);
    }

    let run: RunResult | null = null;
    let tests: TestOutcome[] = [];
    let ai: AiCheckResult[] = [];
    let judges: Record<string, unknown> = {};

    if (loaded && patch) {
      const spec = loaded.spec;
      const testNames = spec.checks.filter((c) => c.type === "test").map((c) => (c as { name: string }).name);
      this.step(job.job_id, "running tests");
      const repoDir = await resolveInRepo(this.o.repoRoot, spec.repo_path);
      run = await runTests({ repoDir, patch, testCommand: spec.test_command, useDocker: this.o.useDocker, timeoutMs: this.o.testTimeoutMs });
      if (!run.applied) problems.push(`patch did not apply: ${run.applyError}`);
      if (run.timedOut) problems.push("tests timed out");
      tests = testOutcomes(testNames, run);
      for (const t of tests) if (!t.found && run.applied) problems.push(`test not found in output: ${t.name}`);
      this.step(job.job_id, "tests done", `${tests.filter((t) => t.pass).length}/${tests.length} passed`);

      const aiChecks = spec.checks.filter((c): c is AiCheck => c.type === "ai");
      if (aiChecks.length && run.applied) {
        this.step(job.job_id, "asking AI judges", this.o.panel.models.join(", "));
        const diff = patch.toString("utf8");
        const out = await this.o.panel.judge({ spec, diff, changedFiles: changedFiles(diff), testSummary: tests }, aiChecks);
        ai = out.results;
        judges = out.receipts;
        if (!this.o.panel.verified) problems.push("AI judges ran in OFFLINE mode: unverified, no TEE attestation");
        this.step(job.job_id, "AI judges done", ai.map((r) => `${r.check.id}:${r.pass ? "pass" : "fail"}`).join(" "));
      } else if (aiChecks.length) {
        problems.push("AI checks skipped: patch did not apply");
      }
    }

    const verdict = buildVerdict({
      jobId: job.job_id,
      specHash: job.spec_hash,
      patchHash: job.patch_hash ?? "",
      spec: loaded?.spec ?? null,
      tests,
      ai,
      isolation: run?.isolation ?? (this.o.useDocker ? "docker" : "tempdir"),
      problems,
      nowMs: await this.o.chain.now(),
    });
    const testReceipt = {
      applied: run?.applied ?? false,
      apply_error: run?.applyError ?? null,
      isolation: verdict.isolation,
      exit_code: run?.exitCode ?? null,
      timed_out: run?.timedOut ?? false,
      tests,
      output_excerpt: (run?.output ?? "").slice(-8000),
    };
    const { receiptsHash, dir } = await writeReceipts({ receiptsDir: this.o.receiptsDir, verdict, tests: testReceipt, judges, secrets: this.o.secrets ?? [] });
    this.step(job.job_id, "receipts written", dir);

    const tx = await this.o.chain.as(this.o.judgeId).submitVerdict({
      job_id: job.job_id,
      score_bps: verdict.score_bps,
      checks_passed: verdict.checks_passed,
      checks_total: verdict.checks_total,
      receipts_hash: receiptsHash,
    });
    this.step(job.job_id, "verdict submitted", `${verdict.checks_passed}/${verdict.checks_total} checks, score ${verdict.score_bps / 100}%`);
    this.log(`job ${job.job_id}: ${verdict.checks_passed}/${verdict.checks_total} checks`, { receiptsHash, tx: tx.tx });
    return { verdict, receiptsHash, receiptsDir: dir, tx: tx.tx };
  }

  /** Settle a judged job once its appeal window has closed. Returns true if settled. */
  async settleIfDue(job: JobView, nowMs: number): Promise<boolean> {
    if (job.status !== "Judged" || !job.verdict || nowMs < job.verdict.appeal_deadline_ms) return false;
    await this.o.chain.as(this.o.judgeId).settle(job.job_id);
    this.step(job.job_id, "settled");
    this.log(`job ${job.job_id}: settled`);
    return true;
  }

  /** One pass: judge every delivered job, settle every due job. Never throws. */
  async tick(): Promise<{ judged: number[]; settled: number[]; errors: string[] }> {
    const judged: number[] = [];
    const settled: number[] = [];
    const errors: string[] = [];
    if (this.ticking) return { judged, settled, errors };
    this.ticking = true;
    try {
      const delivered = await this.o.chain.listJobsByStatus("Delivered", 20);
      for (const job of delivered) {
        if (this.judging.has(job.job_id)) continue; // already judged or being judged elsewhere
        try {
          await this.processJob(job);
          judged.push(job.job_id);
        } catch (e) {
          errors.push(`job ${job.job_id}: ${(e as Error).message}`);
          this.log(`job ${job.job_id} failed: ${(e as Error).message}`);
        }
      }
      const now = await this.o.chain.now();
      for (const job of await this.o.chain.listJobsByStatus("Judged", 50)) {
        try {
          if (await this.settleIfDue(job, now)) settled.push(job.job_id);
        } catch (e) {
          errors.push(`settle ${job.job_id}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      errors.push((e as Error).message);
    } finally {
      this.ticking = false;
    }
    return { judged, settled, errors };
  }

  start(intervalMs = 4000): void {
    if (this.timer) return;
    const loop = async () => {
      await this.tick();
      this.timer = setTimeout(loop, intervalMs);
    };
    this.timer = setTimeout(loop, 0);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

// Runs one full demo scenario (post -> accept -> deliver -> judge -> settle) and
// records each step for the dashboard's Try-it progress panel (SPEC §7).

import { postJob, runAgent, SCENARIOS, type AgentKind } from "@surety/agents";
import type { SuretyChain } from "@surety/shared/chain";
import type { JobView } from "@surety/shared/types";
import type { JudgeWorker } from "./worker.ts";

export interface DemoStep {
  name: string;
  status: "done" | "running" | "failed";
  at_ms: number;
  detail?: string;
  tx_url?: string | null;
}

export interface DemoAccounts {
  client: string;
  honest: string;
  sloppy: string;
  cheater: string;
  /** The cheater's sock-puppet clients. */
  fakeClients: string[];
}

export class RateLimitError extends Error {}

export class DemoRunner {
  private readonly steps = new Map<number, DemoStep[]>();
  private readonly runs: number[] = [];
  private busy = false;
  private cheaterTurn = 0;

  constructor(
    private readonly o: {
      chain: SuretyChain;
      worker: JudgeWorker;
      accounts: DemoAccounts;
      repoRoot: string;
      jobValue?: string;
      maxPerHour?: number;
      now?: () => number;
    },
  ) {}

  private clock() {
    return (this.o.now ?? Date.now)();
  }

  /** Called by the worker's onStep hook. */
  record(jobId: number, name: string, detail?: string, tx?: string) {
    const list = this.steps.get(jobId) ?? [];
    list.push({ name, status: "done", at_ms: this.clock(), detail, tx_url: tx ? this.o.chain.explorerTxUrl(tx) : null });
    this.steps.set(jobId, list);
  }

  isBusy() {
    return this.busy;
  }

  /** Starts a scenario and returns the job id as soon as the job is posted. */
  async start(kind: AgentKind): Promise<number> {
    if (!(kind in SCENARIOS)) throw new Error(`unknown scenario ${kind}`);
    if (this.busy) throw new RateLimitError("a demo run is already in progress, try again in a minute");
    const hourAgo = this.clock() - 3_600_000;
    while (this.runs.length && this.runs[0]! < hourAgo) this.runs.shift();
    if (this.runs.length >= (this.o.maxPerHour ?? 10)) throw new RateLimitError("demo limit reached (10 runs per hour)");
    this.busy = true;
    this.runs.push(this.clock());
    try {
      const { chain, accounts, repoRoot } = this.o;
      const s = SCENARIOS[kind];
      const clientId = kind === "cheater" ? accounts.fakeClients[this.cheaterTurn++ % accounts.fakeClients.length]! : accounts.client;
      const agentId = accounts[kind];
      const pending: [string, string | undefined, string | undefined][] = [];
      const jobId = await postJob({
        chain,
        clientId,
        repoRoot,
        specRef: s.spec,
        value: this.o.jobValue ?? "50000000",
        deadlineMs: (await chain.now()) + 3_600_000,
        log: (step, detail, tx) => pending.push([step, detail, tx]),
      });
      for (const [step, detail, tx] of pending) this.record(jobId, step, detail, tx);
      void this.finish(kind, jobId, agentId).finally(() => {
        this.busy = false;
      });
      return jobId;
    } catch (e) {
      this.busy = false;
      throw e;
    }
  }

  private async finish(kind: AgentKind, jobId: number, agentId: string) {
    try {
      await runAgent({
        chain: this.o.chain,
        agentId,
        jobId,
        repoRoot: this.o.repoRoot,
        patchRef: SCENARIOS[kind].patch,
        log: (step, detail, tx) => this.record(jobId, step, detail, tx),
      });
      const job = await this.o.chain.getJob(jobId);
      await this.o.worker.processJob(job!);
      this.record(jobId, "waiting for the appeal window to close");
    } catch (e) {
      const list = this.steps.get(jobId) ?? [];
      list.push({ name: "failed", status: "failed", at_ms: this.clock(), detail: (e as Error).message });
      this.steps.set(jobId, list);
    }
  }

  async status(jobId: number): Promise<{ job: JobView | null; steps: DemoStep[] }> {
    return { job: await this.o.chain.getJob(jobId), steps: this.steps.get(jobId) ?? [] };
  }
}

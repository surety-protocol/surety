// In-memory reference implementation of the Surety contract (docs/SPEC.md §4,
// MECHANISM.md). Used by tests, the simulation and local demos, and as a worked
// example for the Rust contract. It also holds a tiny tUSDC ledger.

import {
  applyPoolDelta,
  canAccept,
  failureRateBps,
  isCollusionSafe,
  jobWeight,
  premiumBps,
  priceConfig,
  scoreBps as scoreFromCounts,
  settle as settleMath,
  updateRecord,
  BPS,
} from "./pricing.ts";
import { isSha256Hex } from "./hash.ts";
import type { PostJobArgs, SuretyActor, SuretyChain, TxResult, VerdictArgs } from "./chain.ts";
import { ChainError } from "./chain.ts";
import type { AgentView, Config, JobStatus, JobView, U128 } from "./types.ts";
import { DEFAULT_CONFIG, JOB_STATUSES } from "./types.ts";

interface AgentState {
  agent_id: string;
  bond: bigint;
  backers: { backer_id: string; amount: bigint }[];
  open_exposure: bigint;
  weighted_jobs: bigint;
  weighted_failures: bigint;
  jobs_passed: number;
  jobs_partial: number;
  jobs_failed: number;
  registered_ms: number;
  last_settled_ms: number;
}

interface JobState extends Omit<JobView, "value" | "appeal"> {
  value: bigint;
  appeal: null | { appellant_id: string; deposit: bigint; original_score_bps: number; resolved: boolean };
}

export interface ChainEvent {
  event: string;
  data: Record<string, unknown>;
  tx: string;
  at_ms: number;
}

export interface MockChainOptions {
  contractId?: string;
  tokenId?: string;
  judgeId: string;
  panelId: string;
  config?: Partial<Config>;
  startMs?: number;
  /**
   * Experiment switch, not part of SPEC: where the premium goes when an agent has
   * no backers. "bond" (default, MECHANISM 4.1) credits the agent's own bond;
   * "reserve" pays it to `reserveId`, so self-dealt jobs cost the agent money.
   */
  premiumWithoutBackers?: "bond" | "reserve";
  reserveId?: string;
  /** Experiment switch, not part of SPEC: "value/k" (default, MECHANISM 3.1) or "value/k2". */
  repeatClientWeight?: "value/k" | "value/k2";
}

const ACTIVE: JobStatus[] = ["Accepted", "Delivered", "Judged", "Appealed"];

function fail(msg: string): never {
  throw new ChainError(msg);
}

function amount(v: U128, name = "amount"): bigint {
  if (typeof v !== "string" || !/^\d+$/.test(v)) fail(`${name} must be a decimal string`);
  return BigInt(v);
}

function sum(xs: bigint[]): bigint {
  return xs.reduce((a, b) => a + b, 0n);
}

export class MockChain implements SuretyChain {
  readonly contractId: string;
  readonly tokenId: string;
  readonly judgeId: string;
  readonly panelId: string;
  readonly premiumWithoutBackers: "bond" | "reserve";
  readonly reserveId: string;
  readonly repeatClientWeight: "value/k" | "value/k2";
  readonly config: Config;
  readonly events: ChainEvent[] = [];

  private clock: number;
  private txCounter = 0;
  private balances = new Map<string, bigint>();
  private agents = new Map<string, AgentState>();
  private jobs: JobState[] = [];
  private pairCounts = new Map<string, number>();

  constructor(opts: MockChainOptions) {
    this.contractId = opts.contractId ?? "core.surety.testnet";
    this.tokenId = opts.tokenId ?? "tusdc.surety.testnet";
    this.judgeId = opts.judgeId;
    this.panelId = opts.panelId;
    this.premiumWithoutBackers = opts.premiumWithoutBackers ?? "bond";
    this.reserveId = opts.reserveId ?? "reserve.surety.testnet";
    this.repeatClientWeight = opts.repeatClientWeight ?? "value/k";
    this.config = { ...DEFAULT_CONFIG, ...opts.config };
    this.clock = opts.startMs ?? Date.UTC(2026, 10, 10, 12, 0, 0);
    if (!isCollusionSafe(priceConfig(this.config))) {
      fail("config rejected: max_leverage * penalty_bps * client_share_bps must be < 100000000");
    }
  }

  // ---------- test helpers (not part of the contract) ----------

  mint(accountId: string, value: U128): void {
    this.balances.set(accountId, (this.balances.get(accountId) ?? 0n) + amount(value));
  }

  advance(ms: number): void {
    this.clock += ms;
  }

  setTime(ms: number): void {
    this.clock = ms;
  }

  balanceOf(accountId: string): bigint {
    return this.balances.get(accountId) ?? 0n;
  }

  /** Tokens the contract holds must equal bonds + pools + escrow + pending appeal deposits. */
  checkInvariant(): void {
    const held = this.balanceOf(this.contractId);
    const bonds = sum([...this.agents.values()].map((a) => a.bond));
    const pools = sum([...this.agents.values()].flatMap((a) => a.backers.map((b) => b.amount)));
    const escrow = sum(this.jobs.filter((j) => j.status === "Open" || ACTIVE.includes(j.status)).map((j) => j.value));
    const deposits = sum(this.jobs.filter((j) => j.appeal && !j.appeal.resolved).map((j) => j.appeal!.deposit));
    const expected = bonds + pools + escrow + deposits;
    if (held !== expected) fail(`invariant broken: contract holds ${held}, accounts for ${expected}`);
  }

  // ---------- SuretyChain ----------

  async now(): Promise<number> {
    return this.clock;
  }

  explorerTxUrl(): string | null {
    return null;
  }

  async getConfig(): Promise<Config> {
    return { ...this.config };
  }

  async getAgent(agentId: string): Promise<AgentView | null> {
    const a = this.agents.get(agentId);
    return a ? this.agentView(a) : null;
  }

  async listAgents(fromIndex: number, limit: number): Promise<AgentView[]> {
    return [...this.agents.values()].slice(fromIndex, fromIndex + limit).map((a) => this.agentView(a));
  }

  async getJob(jobId: number): Promise<JobView | null> {
    const j = this.jobs[jobId];
    return j ? this.jobView(j) : null;
  }

  async listJobs(fromIndex: number, limit: number): Promise<JobView[]> {
    return [...this.jobs].reverse().slice(fromIndex, fromIndex + limit).map((j) => this.jobView(j));
  }

  async listJobsByStatus(status: JobStatus, limit: number): Promise<JobView[]> {
    if (!JOB_STATUSES.includes(status)) fail(`unknown status ${status}`);
    return this.jobs.filter((j) => j.status === status).slice(0, limit).map((j) => this.jobView(j));
  }

  async getPrice(agentId: string): Promise<{ premium_bps: number; failure_rate_bps: number }> {
    const a = this.agents.get(agentId) ?? fail(`unknown agent ${agentId}`);
    const failure_rate_bps = this.failureRate(a);
    return { failure_rate_bps, premium_bps: premiumBps(failure_rate_bps, priceConfig(this.config)) };
  }

  async ftBalanceOf(accountId: string): Promise<U128> {
    return this.balanceOf(accountId).toString();
  }

  as(accountId: string): SuretyActor {
    const run = <T>(fn: () => T): Promise<TxResult<T>> => {
      // Every call is atomic: on any error, no state changes (we validate before mutating).
      const tx = `mock-tx-${++this.txCounter}`;
      try {
        const value = fn();
        this.checkInvariant();
        return Promise.resolve({ value, tx });
      } catch (e) {
        return Promise.reject(e);
      }
    };
    const c = this;
    return {
      accountId,
      registerAgent: () => run(() => c.registerAgent(accountId)),
      depositBond: (v) => run(() => void c.ftTransferCall(accountId, amount(v), { action: "bond" })),
      depositPool: (agentId, v) => run(() => void c.ftTransferCall(accountId, amount(v), { action: "pool", agent_id: agentId })),
      postJob: (a: PostJobArgs) =>
        run(() =>
          c.ftTransferCall(accountId, amount(a.value, "value"), {
            action: "post_job",
            spec_hash: a.spec_hash,
            spec_url: a.spec_url,
            min_score_bps: a.min_score_bps,
            deadline_ms: a.deadline_ms,
          }) as number,
        ),
      acceptJob: (id) => run(() => c.acceptJob(accountId, id)),
      deliver: (id, url, hash) => run(() => c.deliver(accountId, id, url, hash)),
      submitVerdict: (a: VerdictArgs) => run(() => c.submitVerdict(accountId, a)),
      settle: (id) => run(() => c.settle(id)),
      cancelExpired: (id) => run(() => c.cancelExpired(accountId, id)),
      appeal: (id) => run(() => void c.ftTransferCall(accountId, BigInt(c.config.appeal_deposit), { action: "appeal", job_id: id })),
      resolveAppeal: (id, s) => run(() => c.resolveAppeal(accountId, id, s)),
      withdrawBond: (v) => run(() => c.withdrawBond(accountId, amount(v))),
      withdrawPool: (agentId, v) => run(() => c.withdrawPool(accountId, agentId, amount(v))),
    };
  }

  // ---------- contract logic ----------

  private emit(event: string, data: Record<string, unknown>): void {
    this.events.push({ event, data, tx: `mock-tx-${this.txCounter + 1}`, at_ms: this.clock });
  }

  private move(from: string, to: string, v: bigint): void {
    if (v === 0n) return;
    const fb = this.balanceOf(from);
    if (fb < v) fail(`insufficient tUSDC balance for ${from}`);
    this.balances.set(from, fb - v);
    this.balances.set(to, this.balanceOf(to) + v);
  }

  private failureRate(a: AgentState): number {
    return failureRateBps(a.weighted_failures, a.weighted_jobs, BigInt(this.config.reference_value));
  }

  private poolTotal(a: AgentState): bigint {
    return sum(a.backers.map((b) => b.amount));
  }

  private registerAgent(caller: string): void {
    if (this.agents.has(caller)) fail("agent already registered");
    this.agents.set(caller, {
      agent_id: caller,
      bond: 0n,
      backers: [],
      open_exposure: 0n,
      weighted_jobs: 0n,
      weighted_failures: 0n,
      jobs_passed: 0,
      jobs_partial: 0,
      jobs_failed: 0,
      registered_ms: this.clock,
      last_settled_ms: 0,
    });
    this.emit("agent_registered", { agent_id: caller });
  }

  /** Mirrors ft_transfer_call -> ft_on_transfer. Validates fully before moving tokens. */
  private ftTransferCall(sender: string, value: bigint, msg: Record<string, unknown>): number | void {
    if (value <= 0n) fail("amount must be positive");
    if (this.balanceOf(sender) < value) fail(`insufficient tUSDC balance for ${sender}`);
    switch (msg.action) {
      case "bond": {
        const a = this.agents.get(sender) ?? fail("only a registered agent can post a bond");
        this.move(sender, this.contractId, value);
        a.bond += value;
        this.emit("bond_deposited", { agent_id: sender, amount: value.toString() });
        return;
      }
      case "pool": {
        const agentId = String(msg.agent_id ?? "");
        const a = this.agents.get(agentId) ?? fail(`unknown agent ${agentId}`);
        if (agentId === sender) fail("an agent cannot back itself; use bond");
        const existing = a.backers.find((b) => b.backer_id === sender);
        if (!existing && a.backers.length >= this.config.max_backers_per_agent) fail("too many backers for this agent");
        this.move(sender, this.contractId, value);
        if (existing) existing.amount += value;
        else a.backers.push({ backer_id: sender, amount: value });
        this.emit("pool_deposited", { agent_id: agentId, backer_id: sender, amount: value.toString() });
        return;
      }
      case "post_job": {
        const spec_hash = String(msg.spec_hash ?? "");
        const spec_url = String(msg.spec_url ?? "");
        const min = msg.min_score_bps === undefined ? this.config.default_min_score_bps : Number(msg.min_score_bps);
        const deadline = Number(msg.deadline_ms);
        if (!isSha256Hex(spec_hash)) fail("spec_hash must be 64 lowercase hex characters");
        if (!spec_url) fail("spec_url is required");
        if (!Number.isInteger(min) || min < 1 || min > 10_000) fail("min_score_bps must be 1..10000");
        if (!Number.isFinite(deadline) || deadline <= this.clock) fail("deadline_ms must be in the future");
        this.move(sender, this.contractId, value);
        const job_id = this.jobs.length;
        this.jobs.push({
          job_id,
          client_id: sender,
          value,
          spec_hash,
          spec_url,
          min_score_bps: min,
          deadline_ms: deadline,
          posted_ms: this.clock,
          status: "Open",
          agent_id: null,
          premium_bps: null,
          patch_url: null,
          patch_hash: null,
          verdict: null,
          appeal: null,
          settlement: null,
        });
        this.emit("job_posted", { job_id, client_id: sender, value: value.toString() });
        return job_id;
      }
      case "appeal": {
        const j = this.jobs[Number(msg.job_id)] ?? fail("unknown job");
        if (j.status !== "Judged" || !j.verdict) fail("only a judged job can be appealed");
        if (j.appeal) fail("job already appealed");
        if (this.clock >= j.verdict.appeal_deadline_ms) fail("appeal window closed");
        if (sender !== j.client_id && sender !== j.agent_id) fail("only the client or the agent can appeal");
        if (value !== BigInt(this.config.appeal_deposit)) fail("appeal deposit must equal config.appeal_deposit");
        this.move(sender, this.contractId, value);
        j.appeal = { appellant_id: sender, deposit: value, original_score_bps: j.verdict.score_bps, resolved: false };
        j.status = "Appealed";
        this.emit("job_appealed", { job_id: j.job_id, appellant_id: sender });
        return;
      }
      default:
        fail("unknown msg action");
    }
  }

  private acceptJob(caller: string, jobId: number): void {
    const j = this.jobs[jobId] ?? fail("unknown job");
    const a = this.agents.get(caller) ?? fail("caller is not a registered agent");
    if (j.status !== "Open") fail("job is not open");
    if (this.clock >= j.deadline_ms) fail("job deadline has passed");
    if (j.client_id === caller) fail("an agent cannot accept its own job");
    const check = canAccept({
      bond: a.bond,
      poolTotal: this.poolTotal(a),
      openExposure: a.open_exposure,
      value: j.value,
      config: priceConfig(this.config),
    });
    if (!check.ok) fail(check.reason);
    j.premium_bps = premiumBps(this.failureRate(a), priceConfig(this.config));
    j.agent_id = caller;
    j.status = "Accepted";
    a.open_exposure += j.value;
    this.emit("job_accepted", { job_id: jobId, agent_id: caller, premium_bps: j.premium_bps });
  }

  private deliver(caller: string, jobId: number, patchUrl: string, patchHash: string): void {
    const j = this.jobs[jobId] ?? fail("unknown job");
    if (j.status !== "Accepted") fail("job is not accepted");
    if (j.agent_id !== caller) fail("only the assigned agent can deliver");
    if (this.clock >= j.deadline_ms) fail("job deadline has passed");
    if (!patchUrl) fail("patch_url is required");
    if (!isSha256Hex(patchHash)) fail("patch_hash must be 64 lowercase hex characters");
    j.patch_url = patchUrl;
    j.patch_hash = patchHash;
    j.status = "Delivered";
    this.emit("job_delivered", { job_id: jobId, agent_id: caller, patch_hash: patchHash });
  }

  private submitVerdict(caller: string, v: VerdictArgs): void {
    if (caller !== this.judgeId) fail("only the judge can submit verdicts");
    const j = this.jobs[v.job_id] ?? fail("unknown job");
    if (j.status !== "Delivered") fail("job is not delivered");
    if (!isSha256Hex(v.receipts_hash)) fail("receipts_hash must be 64 lowercase hex characters");
    let expected: number;
    try {
      expected = scoreFromCounts(v.checks_passed, v.checks_total);
    } catch {
      fail("bad check counts");
    }
    if (expected !== v.score_bps) fail("score_bps does not match checks_passed / checks_total");
    j.verdict = {
      score_bps: v.score_bps,
      checks_passed: v.checks_passed,
      checks_total: v.checks_total,
      receipts_hash: v.receipts_hash,
      judged_ms: this.clock,
      appeal_deadline_ms: this.clock + this.config.appeal_window_ms,
    };
    j.status = "Judged";
    this.emit("verdict_submitted", { job_id: v.job_id, score_bps: v.score_bps, receipts_hash: v.receipts_hash });
  }

  private resolveAppeal(caller: string, jobId: number, finalScore: number): void {
    if (caller !== this.panelId) fail("only the appeal panel can resolve appeals");
    const j = this.jobs[jobId] ?? fail("unknown job");
    if (j.status !== "Appealed" || !j.appeal || !j.verdict) fail("job is not under appeal");
    if (!Number.isInteger(finalScore) || finalScore < 0 || finalScore > 10_000) fail("score_bps must be 0..10000");
    const byClient = j.appeal.appellant_id === j.client_id;
    const favoured = byClient ? finalScore < j.appeal.original_score_bps : finalScore > j.appeal.original_score_bps;
    const other = byClient ? j.agent_id! : j.client_id;
    this.move(this.contractId, favoured ? j.appeal.appellant_id : other, j.appeal.deposit);
    j.appeal.resolved = true;
    j.verdict.score_bps = finalScore;
    j.verdict.appeal_deadline_ms = this.clock;
    j.status = "Judged";
    this.emit("appeal_resolved", { job_id: jobId, score_bps: finalScore, deposit_to: favoured ? j.appeal.appellant_id : other });
  }

  private settle(jobId: number): void {
    const j = this.jobs[jobId] ?? fail("unknown job");
    if (j.status !== "Judged" || !j.verdict) fail("job is not ready to settle");
    if (this.clock < j.verdict.appeal_deadline_ms) fail("appeal window still open");
    this.settleWithScore(j, j.verdict.score_bps);
  }

  private settleWithScore(j: JobState, score: number): void {
    const a = this.agents.get(j.agent_id!) ?? fail("agent missing");
    const hasBackers = a.backers.length > 0 && this.poolTotal(a) > 0n;
    const r = settleMath({
      value: j.value,
      scoreBps: score,
      minScoreBps: j.min_score_bps,
      premiumBps: j.premium_bps ?? 0,
      bond: a.bond,
      poolTotal: this.poolTotal(a),
      hasBackers,
      config: priceConfig(this.config),
    });
    // Money: the escrowed value plus any penalty leaves the contract as payouts.
    const toReserve = this.premiumWithoutBackers === "reserve" ? r.to_bond : 0n;
    a.bond = a.bond - r.from_bond + r.to_bond - toReserve;
    this.move(this.contractId, this.reserveId, toReserve);
    if (r.from_pool > 0n) a.backers = applyPoolDelta(a.backers, -r.from_pool);
    if (r.to_pool > 0n) a.backers = applyPoolDelta(a.backers, r.to_pool);
    this.move(this.contractId, a.agent_id, r.to_agent);
    this.move(this.contractId, j.client_id, r.to_client);
    // Record.
    const key = `${a.agent_id}|${j.client_id}`;
    const k = (this.pairCounts.get(key) ?? 0) + 1;
    this.pairCounts.set(key, k);
    const weight = this.repeatClientWeight === "value/k2" ? jobWeight(j.value, k * k) : jobWeight(j.value, k);
    const rec = updateRecord(a, weight, score);
    a.weighted_jobs = rec.weighted_jobs;
    a.weighted_failures = rec.weighted_failures;
    if (r.outcome === "Pass") a.jobs_passed++;
    else if (r.outcome === "Partial") a.jobs_partial++;
    else a.jobs_failed++;
    a.open_exposure -= j.value;
    a.last_settled_ms = this.clock;
    j.status = "Settled";
    j.settlement = {
      outcome: r.outcome,
      to_agent: r.to_agent.toString(),
      to_client: r.to_client.toString(),
      to_pool: (r.to_pool + r.to_bond).toString(),
      from_bond: r.from_bond.toString(),
      from_pool: r.from_pool.toString(),
      settled_ms: this.clock,
    };
    this.emit("job_settled", { job_id: j.job_id, agent_id: a.agent_id, ...j.settlement });
  }

  private cancelExpired(caller: string, jobId: number): void {
    const j = this.jobs[jobId] ?? fail("unknown job");
    if (caller !== j.client_id) fail("only the client can cancel");
    if (j.status === "Open") {
      this.move(this.contractId, j.client_id, j.value);
      j.status = "Cancelled";
      this.emit("job_cancelled", { job_id: jobId });
      return;
    }
    if (j.status === "Accepted" && this.clock >= j.deadline_ms) {
      this.settleWithScore(j, 0);
      return;
    }
    fail("job cannot be cancelled now");
  }

  private withdrawLock(a: AgentState): void {
    if (a.open_exposure > 0n) fail("withdrawals are locked while the agent has open jobs");
    if (a.last_settled_ms > 0 && this.clock < a.last_settled_ms + this.config.withdraw_cooldown_ms) fail("withdrawal cooldown has not passed");
  }

  private withdrawBond(caller: string, v: bigint): void {
    const a = this.agents.get(caller) ?? fail("caller is not a registered agent");
    if (v <= 0n || v > a.bond) fail("bad withdrawal amount");
    this.withdrawLock(a);
    const left = a.bond - v;
    if (left !== 0n && left < BigInt(this.config.min_bond)) fail("bond must stay 0 or at least min_bond");
    this.move(this.contractId, caller, v);
    a.bond = left;
    this.emit("withdrawn", { agent_id: caller, kind: "bond", amount: v.toString() });
  }

  private withdrawPool(caller: string, agentId: string, v: bigint): void {
    const a = this.agents.get(agentId) ?? fail(`unknown agent ${agentId}`);
    const b = a.backers.find((x) => x.backer_id === caller) ?? fail("caller has no stake in this pool");
    if (v <= 0n || v > b.amount) fail("bad withdrawal amount");
    this.withdrawLock(a);
    this.move(this.contractId, caller, v);
    b.amount -= v;
    if (b.amount === 0n) a.backers = a.backers.filter((x) => x !== b);
    this.emit("withdrawn", { agent_id: agentId, backer_id: caller, kind: "pool", amount: v.toString() });
  }

  // ---------- views ----------

  private agentView(a: AgentState): AgentView {
    const failure_rate_bps = this.failureRate(a);
    return {
      agent_id: a.agent_id,
      bond: a.bond.toString(),
      pool_total: this.poolTotal(a).toString(),
      backers: a.backers.map((b) => ({ backer_id: b.backer_id, amount: b.amount.toString() })),
      open_exposure: a.open_exposure.toString(),
      weighted_jobs: a.weighted_jobs.toString(),
      weighted_failures: a.weighted_failures.toString(),
      failure_rate_bps,
      premium_bps: premiumBps(failure_rate_bps, priceConfig(this.config)),
      jobs_passed: a.jobs_passed,
      jobs_partial: a.jobs_partial,
      jobs_failed: a.jobs_failed,
      registered_ms: a.registered_ms,
    };
  }

  private jobView(j: JobState): JobView {
    return {
      ...structuredClone({ ...j, value: undefined, appeal: undefined }),
      value: j.value.toString(),
      appeal: j.appeal
        ? { appellant_id: j.appeal.appellant_id, deposit: j.appeal.deposit.toString(), original_score_bps: j.appeal.original_score_bps }
        : null,
    } as JobView;
  }
}

export { BPS };

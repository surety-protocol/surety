// One interface for talking to the Surety contract, implemented twice:
//   - NearChain (near.ts): the real contract on testnet
//   - MockChain (mock-chain.ts): an in-memory copy of the same rules, for tests,
//     the simulation and local demos
// Method names and arguments follow docs/SPEC.md section 4.

import type { AgentView, Config, JobStatus, JobView, U128 } from "./types.ts";

export interface PostJobArgs {
  value: U128;
  spec_hash: string;
  spec_url: string;
  min_score_bps?: number;
  deadline_ms: number;
}

export interface VerdictArgs {
  job_id: number;
  score_bps: number;
  checks_passed: number;
  checks_total: number;
  receipts_hash: string;
}

export interface TxResult<T = void> {
  value: T;
  /** Transaction hash on NEAR; a synthetic id on MockChain. */
  tx: string;
}

export interface SuretyReader {
  readonly contractId: string;
  readonly tokenId: string;
  getConfig(): Promise<Config>;
  getAgent(agentId: string): Promise<AgentView | null>;
  listAgents(fromIndex: number, limit: number): Promise<AgentView[]>;
  getJob(jobId: number): Promise<JobView | null>;
  listJobs(fromIndex: number, limit: number): Promise<JobView[]>;
  listJobsByStatus(status: JobStatus, limit: number): Promise<JobView[]>;
  getPrice(agentId: string): Promise<{ premium_bps: number; failure_rate_bps: number }>;
  ftBalanceOf(accountId: string): Promise<U128>;
}

/** Signed actions, performed as one account. */
export interface SuretyActor {
  readonly accountId: string;
  registerAgent(): Promise<TxResult>;
  depositBond(amount: U128): Promise<TxResult>;
  depositPool(agentId: string, amount: U128): Promise<TxResult>;
  postJob(args: PostJobArgs): Promise<TxResult<number>>;
  acceptJob(jobId: number): Promise<TxResult>;
  deliver(jobId: number, patchUrl: string, patchHash: string): Promise<TxResult>;
  submitVerdict(args: VerdictArgs): Promise<TxResult>;
  settle(jobId: number): Promise<TxResult>;
  cancelExpired(jobId: number): Promise<TxResult>;
  appeal(jobId: number): Promise<TxResult>;
  resolveAppeal(jobId: number, scoreBps: number): Promise<TxResult>;
  withdrawBond(amount: U128): Promise<TxResult>;
  withdrawPool(agentId: string, amount: U128): Promise<TxResult>;
}

export interface SuretyChain extends SuretyReader {
  /** Act as this account. Throws if no key is available for it. */
  as(accountId: string): SuretyActor;
  /** Current chain time in ms (block time on NEAR). */
  now(): Promise<number>;
  /** Link to a transaction in a block explorer, or null for MockChain. */
  explorerTxUrl(tx: string): string | null;
}

export class ChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainError";
  }
}

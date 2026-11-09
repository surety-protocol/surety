// SuretyChain backed by the real contract on NEAR (docs/SPEC.md §4), using
// near-api-js v7. All RPC goes through a small Transport so tests can check the
// exact method names, arguments, deposits and gas without a network.

import { Account, JsonRpcProvider, teraToGas, type KeyPairString } from "near-api-js";
import type { PostJobArgs, SuretyActor, SuretyChain, TxResult, VerdictArgs } from "./chain.ts";
import { ChainError } from "./chain.ts";
import type { AgentView, Config, JobStatus, JobView, U128 } from "./types.ts";

export interface ChangeCall {
  signerId: string;
  receiverId: string;
  methodName: string;
  args: Record<string, unknown>;
  deposit: bigint;
  gas: bigint;
}

export interface ChangeOutcome {
  tx: string;
  /** Every log line from every receipt, in order. */
  logs: string[];
  /** Decoded JSON return value of the first function call, if any. */
  returnValue: unknown;
}

export interface Transport {
  view<T>(contractId: string, method: string, args: Record<string, unknown>): Promise<T>;
  change(call: ChangeCall): Promise<ChangeOutcome>;
  blockTimeMs(): Promise<number>;
}

const GAS_DEFAULT = teraToGas("50");
const GAS_FT_CALL = teraToGas("150");
const GAS_SETTLE = teraToGas("150");
const ONE_YOCTO = 1n;

export interface SuretyEvent {
  standard: string;
  version: string;
  event: string;
  data: Record<string, unknown>[];
}

/** Parse NEP-297 `EVENT_JSON:` log lines; other lines are ignored. */
export function parseEvents(logs: string[]): SuretyEvent[] {
  const out: SuretyEvent[] = [];
  for (const line of logs) {
    if (!line.startsWith("EVENT_JSON:")) continue;
    try {
      const e = JSON.parse(line.slice("EVENT_JSON:".length)) as SuretyEvent;
      if (e && typeof e.event === "string" && Array.isArray(e.data)) out.push(e);
    } catch {
      // A malformed event line is not ours; skip it.
    }
  }
  return out;
}

export class NearChain implements SuretyChain {
  constructor(
    readonly contractId: string,
    readonly tokenId: string,
    private readonly transport: Transport,
    private readonly network: "testnet" | "mainnet" = "testnet",
  ) {
    if (network !== "testnet") throw new ChainError("Surety runs on testnet only");
  }

  private view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.transport.view<T>(this.contractId, method, args);
  }

  getConfig(): Promise<Config> {
    return this.view("get_config");
  }
  getAgent(agentId: string): Promise<AgentView | null> {
    return this.view("get_agent", { agent_id: agentId });
  }
  listAgents(fromIndex: number, limit: number): Promise<AgentView[]> {
    return this.view("list_agents", { from_index: fromIndex, limit });
  }
  getJob(jobId: number): Promise<JobView | null> {
    return this.view("get_job", { job_id: jobId });
  }
  listJobs(fromIndex: number, limit: number): Promise<JobView[]> {
    return this.view("list_jobs", { from_index: fromIndex, limit });
  }
  listJobsByStatus(status: JobStatus, limit: number): Promise<JobView[]> {
    return this.view("list_jobs_by_status", { status, limit });
  }
  getPrice(agentId: string): Promise<{ premium_bps: number; failure_rate_bps: number }> {
    return this.view("get_price", { agent_id: agentId });
  }
  ftBalanceOf(accountId: string): Promise<U128> {
    return this.transport.view<U128>(this.tokenId, "ft_balance_of", { account_id: accountId });
  }
  now(): Promise<number> {
    return this.transport.blockTimeMs();
  }
  explorerTxUrl(tx: string): string {
    return `https://testnet.nearblocks.io/txns/${tx}`;
  }

  as(accountId: string): SuretyActor {
    const call = async (
      methodName: string,
      args: Record<string, unknown>,
      opts: { deposit?: bigint; gas?: bigint; receiver?: string } = {},
    ): Promise<ChangeOutcome> =>
      this.transport.change({
        signerId: accountId,
        receiverId: opts.receiver ?? this.contractId,
        methodName,
        args,
        deposit: opts.deposit ?? 0n,
        gas: opts.gas ?? GAS_DEFAULT,
      });
    const done = (o: ChangeOutcome): TxResult => ({ value: undefined, tx: o.tx });
    const ftCall = (value: U128, msg: Record<string, unknown>) =>
      call("ft_transfer_call", { receiver_id: this.contractId, amount: value, msg: JSON.stringify(msg) }, {
        receiver: this.tokenId,
        deposit: ONE_YOCTO,
        gas: GAS_FT_CALL,
      });

    return {
      accountId,
      registerAgent: async () => done(await call("register_agent", {})),
      depositBond: async (v) => done(await ftCall(v, { action: "bond" })),
      depositPool: async (agentId, v) => done(await ftCall(v, { action: "pool", agent_id: agentId })),
      postJob: async (a: PostJobArgs) => {
        const msg: Record<string, unknown> = {
          action: "post_job",
          spec_hash: a.spec_hash,
          spec_url: a.spec_url,
          deadline_ms: a.deadline_ms,
        };
        if (a.min_score_bps !== undefined) msg.min_score_bps = a.min_score_bps;
        const o = await ftCall(a.value, msg);
        const posted = parseEvents(o.logs).find((e) => e.event === "job_posted");
        const id = posted?.data[0]?.job_id;
        if (typeof id !== "number") {
          throw new ChainError("job was not posted: no job_posted event (the token contract may have refunded the transfer)");
        }
        return { value: id, tx: o.tx };
      },
      acceptJob: async (id) => done(await call("accept_job", { job_id: id })),
      deliver: async (id, url, hash) => done(await call("deliver", { job_id: id, patch_url: url, patch_hash: hash })),
      submitVerdict: async (v: VerdictArgs) => done(await call("submit_verdict", { ...v })),
      settle: async (id) => done(await call("settle", { job_id: id }, { gas: GAS_SETTLE })),
      cancelExpired: async (id) => done(await call("cancel_expired", { job_id: id }, { gas: GAS_SETTLE })),
      appeal: async (id) => {
        const cfg = await this.getConfig();
        return done(await ftCall(cfg.appeal_deposit, { action: "appeal", job_id: id }));
      },
      resolveAppeal: async (id, s) => done(await call("resolve_appeal", { job_id: id, score_bps: s })),
      withdrawBond: async (v) => done(await call("withdraw_bond", { amount: v }, { gas: GAS_SETTLE })),
      withdrawPool: async (agentId, v) => done(await call("withdraw_pool", { agent_id: agentId, amount: v }, { gas: GAS_SETTLE })),
    };
  }
}

/** Real transport over JSON-RPC. `keys` maps account id -> secret key ("ed25519:..."). */
export class RpcTransport implements Transport {
  private readonly provider: JsonRpcProvider;

  constructor(
    rpcUrl: string,
    private readonly keys: Map<string, string>,
  ) {
    this.provider = new JsonRpcProvider({ url: rpcUrl });
  }

  async view<T>(contractId: string, method: string, args: Record<string, unknown>): Promise<T> {
    return (await this.provider.callFunction({ contractId, method, args })) as T;
  }

  async blockTimeMs(): Promise<number> {
    const block = await this.provider.viewBlock({ finality: "final" });
    return Math.floor(Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n));
  }

  async change(c: ChangeCall): Promise<ChangeOutcome> {
    const key = this.keys.get(c.signerId);
    if (!key) throw new ChainError(`no key configured for ${c.signerId}`);
    const account = new Account(c.signerId, this.provider, key as KeyPairString);
    const res = await account.callFunctionRaw({
      contractId: c.receiverId,
      methodName: c.methodName,
      args: c.args,
      deposit: c.deposit,
      gas: c.gas,
    });
    const r = res as unknown as {
      transaction: { hash: string };
      status: { SuccessValue?: string; Failure?: unknown };
      receipts_outcome: { outcome: { logs: string[]; status: { Failure?: unknown } } }[];
    };
    const logs = r.receipts_outcome.flatMap((x) => x.outcome.logs);
    const failed = r.receipts_outcome.find((x) => x.outcome.status && "Failure" in x.outcome.status);
    if (r.status && "Failure" in r.status) throw new ChainError(`transaction failed: ${JSON.stringify(r.status.Failure)}`);
    if (failed) throw new ChainError(`a receipt failed: ${JSON.stringify(failed.outcome.status.Failure)}`);
    let returnValue: unknown;
    if (r.status?.SuccessValue) {
      const text = Buffer.from(r.status.SuccessValue, "base64").toString("utf8");
      try {
        returnValue = JSON.parse(text);
      } catch {
        returnValue = text;
      }
    }
    return { tx: r.transaction.hash, logs, returnValue };
  }
}

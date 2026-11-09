// Scripted agent and client actions. The agents are scripts, not live AI, so the
// demo is reproducible: each one delivers a fixed patch file.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Hex } from "@surety/shared/hash";
import type { SuretyChain, TxResult } from "@surety/shared/chain";

export type AgentKind = "honest" | "sloppy" | "cheater";

export const SCENARIOS: Record<AgentKind, { spec: string; patch: string }> = {
  honest: { spec: "agents/jobs/login-bug.json", patch: "agents/patches/honest-login-bug.diff" },
  sloppy: { spec: "agents/jobs/login-bug.json", patch: "agents/patches/sloppy-login-bug.diff" },
  cheater: { spec: "agents/jobs/easy-comment.json", patch: "agents/patches/cheater-easy-comment.diff" },
};

export async function fileHash(repoRoot: string, ref: string): Promise<string> {
  return sha256Hex(await readFile(join(repoRoot, ref)));
}

export interface StepLog {
  (step: string, detail?: string, tx?: string): void;
}

/** Client posts a job for a spec file in the repo. Returns the job id. */
export async function postJob(a: {
  chain: SuretyChain;
  clientId: string;
  repoRoot: string;
  specRef: string;
  value: string;
  deadlineMs: number;
  log?: StepLog;
}): Promise<number> {
  const specHash = await fileHash(a.repoRoot, a.specRef);
  const r = await a.chain.as(a.clientId).postJob({ value: a.value, spec_hash: specHash, spec_url: a.specRef, deadline_ms: a.deadlineMs });
  a.log?.("job posted", `job ${r.value}, ${a.value} units escrowed by ${a.clientId}`, r.tx);
  return r.value;
}

/** Register (if needed), top up the bond to `minBond` (if a funding key is available), accept and deliver. */
export async function runAgent(a: {
  chain: SuretyChain;
  agentId: string;
  jobId: number;
  repoRoot: string;
  patchRef: string;
  /** Account that can fund the bond via ft_transfer_call (needs a full-access key). Defaults to the agent itself. */
  bondFunder?: string;
  log?: StepLog;
}): Promise<{ accept: TxResult; deliver: TxResult }> {
  const agent = a.chain.as(a.agentId);
  let view = await a.chain.getAgent(a.agentId);
  if (!view) {
    const r = await agent.registerAgent();
    a.log?.("agent registered", a.agentId, r.tx);
    view = await a.chain.getAgent(a.agentId);
  }
  const cfg = await a.chain.getConfig();
  if (BigInt(view!.bond) < BigInt(cfg.min_bond)) {
    const need = (BigInt(cfg.min_bond) - BigInt(view!.bond)).toString();
    const r = await a.chain.as(a.bondFunder ?? a.agentId).depositBond(need);
    a.log?.("bond posted", `${need} units`, r.tx);
  }
  const accept = await agent.acceptJob(a.jobId);
  const job = await a.chain.getJob(a.jobId);
  a.log?.("job accepted", `${a.agentId} at a ${(job?.premium_bps ?? 0) / 100}% premium`, accept.tx);
  const patchHash = await fileHash(a.repoRoot, a.patchRef);
  const deliver = await agent.deliver(a.jobId, a.patchRef, patchHash);
  a.log?.("patch delivered", a.patchRef, deliver.tx);
  return { accept, deliver };
}

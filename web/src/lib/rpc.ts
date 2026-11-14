/**
 * NEAR RPC view-call helper.
 *
 * Live contract methods (from docs/SPEC.md):
 *   list_agents({ from_index, limit })
 *   list_jobs({ from_index, limit })
 *   list_jobs_by_status({ status, limit })
 *   get_agent({ agent_id })
 *   get_job({ job_id: number })
 *
 * Overview stats are computed on the frontend — no get_overview on-chain.
 * Price history is derived from settled jobs (premium_bps per job).
 *
 * Switch to live: VITE_USE_MOCK=false in .env.local
 */

import { MOCK_AGENTS, MOCK_JOBS, MOCK_RECEIPTS } from '../mock/fixture';
import type { AgentView, AgentWithHistory, JobView, JobStatus, OverviewStats, PricePoint, Verdict } from '../shared/types';

export const USE_MOCK =
  import.meta.env.VITE_USE_MOCK === undefined ||
  import.meta.env.VITE_USE_MOCK !== 'false';

const RPC_URL =
  import.meta.env.VITE_RPC_URL ?? 'https://rpc.testnet.near.org';
const CONTRACT_ID =
  import.meta.env.VITE_CONTRACT_ID ?? 'TODO_DEPLOY_surety.testnet';

const mockDelay = (ms = 400) => new Promise((r) => setTimeout(r, ms));

// ─── RPC helper ───────────────────────────────────────────────────────────────

async function viewCall<T>(method: string, args: object = {}): Promise<T> {
  const body = {
    jsonrpc: '2.0',
    id: 'surety-dashboard',
    method: 'query',
    params: {
      request_type: 'call_function',
      finality: 'final',
      account_id: CONTRACT_ID,
      method_name: method,
      args_base64: btoa(JSON.stringify(args)),
    },
  };
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json() as { error?: { message: string }; result?: { result: number[] } };
  if (json.error) throw new Error(json.error.message);
  const bytes = json.result!.result;
  return JSON.parse(new TextDecoder().decode(new Uint8Array(bytes))) as T;
}

// ─── Price history helper ─────────────────────────────────────────────────────

/**
 * Build price history for an agent from settled jobs.
 * premium_bps is the value locked at accept time on each job.
 */
function buildPriceHistory(agentId: string, jobs: JobView[]): PricePoint[] {
  return jobs
    .filter(
      (j) =>
        j.agent_id === agentId &&
        j.status === 'Settled' &&
        j.settlement !== null &&
        j.premium_bps !== null
    )
    .sort((a, b) => (a.settlement!.settled_ms) - (b.settlement!.settled_ms))
    .map((j) => ({
      timestamp: j.settlement!.settled_ms,
      premium_bps: j.premium_bps!,
    }));
}

// ─── Overview (computed from agent + job lists) ───────────────────────────────

function computeOverview(agents: AgentView[], jobs: JobView[]): OverviewStats {
  const total_bonded = agents
    .reduce((sum, a) => sum + BigInt(a.bond), 0n)
    .toString();

  const total_refunded = jobs
    .filter((j) => j.settlement?.outcome === 'Fail' || j.settlement?.outcome === 'Partial')
    .reduce((sum, j) => sum + BigInt(j.settlement!.to_client), 0n)
    .toString();

  return {
    agent_count: agents.length,
    job_count: jobs.length,
    total_bonded,
    total_refunded,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function fetchAgents(): Promise<AgentWithHistory[]> {
  if (USE_MOCK) {
    await mockDelay();
    return MOCK_AGENTS.map((a) => ({ ...a, price_history: buildPriceHistory(a.agent_id, MOCK_JOBS) }));
  }
  const agents = await viewCall<AgentView[]>('list_agents', { from_index: 0, limit: 50 });
  // Attach derived price history
  const jobs = await viewCall<JobView[]>('list_jobs', { from_index: 0, limit: 500 });
  return agents.map((a) => ({
    ...a,
    price_history: buildPriceHistory(a.agent_id, jobs),
  }));
}

export async function fetchAgent(agent_id: string): Promise<AgentWithHistory | null> {
  if (USE_MOCK) {
    await mockDelay(200);
    const agent = MOCK_AGENTS.find((a) => a.agent_id === agent_id) ?? null;
    return agent && { ...agent, price_history: buildPriceHistory(agent_id, MOCK_JOBS) };
  }
  const agent = await viewCall<AgentView | null>('get_agent', { agent_id });
  if (!agent) return null;
  const jobs = await viewCall<JobView[]>('list_jobs_by_status', { status: 'Settled', limit: 500 });
  return { ...agent, price_history: buildPriceHistory(agent_id, jobs) };
}

export async function fetchJobs(status?: JobStatus): Promise<JobView[]> {
  if (USE_MOCK) {
    await mockDelay();
    if (status) return MOCK_JOBS.filter((j) => j.status === status);
    return MOCK_JOBS;
  }
  if (status) {
    return viewCall<JobView[]>('list_jobs_by_status', { status, limit: 50 });
  }
  return viewCall<JobView[]>('list_jobs', { from_index: 0, limit: 50 });
}

export async function fetchJob(job_id: number): Promise<JobView | null> {
  if (USE_MOCK) {
    await mockDelay(200);
    return MOCK_JOBS.find((j) => j.job_id === job_id) ?? null;
  }
  return viewCall<JobView | null>('get_job', { job_id });
}

export async function fetchOverview(): Promise<OverviewStats> {
  if (USE_MOCK) {
    await mockDelay();
    return computeOverview(MOCK_AGENTS, MOCK_JOBS);
  }
  const [agents, jobs] = await Promise.all([
    viewCall<AgentView[]>('list_agents', { from_index: 0, limit: 50 }),
    viewCall<JobView[]>('list_jobs', { from_index: 0, limit: 500 }),
  ]);
  return computeOverview(agents, jobs);
}

const DEMO_API = import.meta.env.VITE_DEMO_API_URL ?? 'http://localhost:8787';

/**
 * Where receipt files live. Locally the judge serves them (SPEC section 7:
 * GET /receipts/:job_id/:file). The hosted build ships a copy of the committed
 * receipts as static files and sets VITE_RECEIPTS_BASE=/receipts.
 */
const RECEIPTS_BASE = import.meta.env.VITE_RECEIPTS_BASE ?? `${DEMO_API}/receipts`;

export function receiptUrl(job_id: number, file: string): string {
  return `${RECEIPTS_BASE}/${job_id}/${encodeURIComponent(file)}`;
}

/** The judge's verdict.json for a job (SPEC section 6). */
export async function fetchReceipt(job_id: number): Promise<Verdict | null> {
  if (USE_MOCK) {
    await mockDelay(300);
    return MOCK_RECEIPTS[job_id] ?? null;
  }
  const res = await fetch(receiptUrl(job_id, 'verdict.json'));
  if (!res.ok) return null;
  return res.json() as Promise<Verdict>;
}

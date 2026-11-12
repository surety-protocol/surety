/**
 * Try-it client for the judge's demo API (docs/SPEC.md section 7).
 *
 *   POST /demo/run              body { scenario }        -> { job_id }
 *   GET  /demo/status/:job_id   -> { job, steps: [{ name, status, at_ms, detail, tx_url }] }
 *
 * Steps are appended by the server as they happen. A run is finished when the
 * job is Settled (the judge settles it after the appeal window) or a step failed.
 * In mock mode the same step names are replayed locally against fixture jobs.
 */

import type { DemoRun, DemoScenario, DemoStatus, DemoStep, JobView } from '../shared/types';
import { USE_MOCK } from './rpc';
import { MOCK_JOBS } from '../mock/fixture';

const DEMO_API = import.meta.env.VITE_DEMO_API_URL ?? 'http://localhost:8787';

function runState(job: JobView | null, steps: DemoStep[]): DemoRun['status'] {
  if (steps.some((s) => s.status === 'failed')) return 'error';
  if (job && (job.status === 'Settled' || job.status === 'Cancelled')) return 'done';
  return 'running';
}

// ─── Mock runner ──────────────────────────────────────────────────────────────

const MOCK_SCRIPT: Record<DemoScenario, [string, string?][]> = {
  honest: [
    ['job posted', '50 tUSDC escrowed'],
    ['job accepted', 'premium 7.00% locked'],
    ['patch delivered'],
    ['loading spec and patch'],
    ['running tests'],
    ['tests done', '5/5 tests pass'],
    ['asking AI judges'],
    ['AI judges done', '2/2 AI checks pass, 3/3 votes TEE-verified'],
    ['receipts written'],
    ['verdict submitted', 'score 100.00% (7/7)'],
    ['waiting for the appeal window to close'],
    ['settled', 'Pass: 46.50 to agent, 3.50 premium'],
  ],
  sloppy: [
    ['job posted', '50 tUSDC escrowed'],
    ['job accepted', 'premium 7.00% locked'],
    ['patch delivered'],
    ['loading spec and patch'],
    ['running tests'],
    ['tests done', '2/5 tests pass'],
    ['asking AI judges'],
    ['AI judges done', '0/2 AI checks pass'],
    ['receipts written'],
    ['verdict submitted', 'score 28.57% (2/7)'],
    ['waiting for the appeal window to close'],
    ['settled', 'Fail: client gets 60.00 (50 escrow + 10 from the bond)'],
  ],
  cheater: [
    ['job posted', 'from a sock-puppet client'],
    ['job accepted'],
    ['patch delivered'],
    ['loading spec and patch'],
    ['running tests'],
    ['tests done', '1/1 tests pass'],
    ['verdict submitted', 'score 100.00% (1/1)'],
    ['waiting for the appeal window to close'],
    ['settled', 'Pass, but a repeat client counts value / k toward the record'],
  ],
};

const mockRuns = new Map<number, DemoRun>();
let mockCounter = 0;

function mockFinalJob(scenario: DemoScenario): JobView | null {
  const outcome = scenario === 'sloppy' ? 'Fail' : 'Pass';
  return MOCK_JOBS.find((j) => j.settlement?.outcome === outcome) ?? null;
}

async function advanceMockRun(key: number, scenario: DemoScenario) {
  for (const [name, detail] of MOCK_SCRIPT[scenario]) {
    await new Promise<void>((r) => setTimeout(r, 700 + Math.random() * 600));
    const run = mockRuns.get(key);
    if (!run) return;
    const steps = [...run.steps, { name, status: 'done' as const, at_ms: Date.now(), detail }];
    const job = name === 'settled' ? mockFinalJob(scenario) : null;
    mockRuns.set(key, { ...run, steps, job, status: name === 'settled' ? 'done' : 'running' });
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Start a run. Poll pollDemoStatus() for progress. */
export async function startDemoRun(scenario: DemoScenario): Promise<DemoRun> {
  if (USE_MOCK) {
    const key = -++mockCounter; // negative ids never collide with real jobs
    const run: DemoRun = { job_id: key, scenario, steps: [], job: null, status: 'running' };
    mockRuns.set(key, run);
    void advanceMockRun(key, scenario);
    return run;
  }
  const res = await fetch(`${DEMO_API}/demo/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Demo API returned ${res.status}`);
  }
  const { job_id } = (await res.json()) as { job_id: number };
  return { job_id, scenario, steps: [], job: null, status: 'running' };
}

/** GET /demo/status/:job_id */
export async function pollDemoStatus(run: DemoRun): Promise<DemoRun> {
  if (USE_MOCK) {
    const r = mockRuns.get(run.job_id);
    if (!r) throw new Error('mock run not found');
    return { ...r, steps: [...r.steps] };
  }
  const res = await fetch(`${DEMO_API}/demo/status/${run.job_id}`);
  if (!res.ok) throw new Error(`Demo API returned ${res.status}`);
  const data = (await res.json()) as DemoStatus;
  return { ...run, steps: data.steps, job: data.job, status: runState(data.job, data.steps) };
}

/**
 * Contract and judge shapes come from @surety/shared (docs/SPEC.md sections 4.5
 * and 6), so the dashboard can never drift from the contract. Only UI-only types
 * live here.
 */

export type {
  AgentView,
  AiVote,
  CheckResult,
  JobStatus,
  JobView,
  Settlement,
  Verdict,
} from '@surety/shared/types';
import type { AgentView, JobView } from '@surety/shared/types';

/** Token amounts are U128 strings in 6-decimal units. Display as tUSDC. */
export type MicroUSDC = string;
export type AccountId = string;
export type Backer = AgentView['backers'][number];

/** Derived on the frontend from settled jobs. */
export type PricePoint = {
  timestamp: number; // settled_ms of the job
  premium_bps: number; // premium locked on that job
};

export type AgentWithHistory = AgentView & { price_history?: PricePoint[] };

export type OverviewStats = {
  agent_count: number;
  job_count: number;
  total_bonded: MicroUSDC;
  total_refunded: MicroUSDC; // to_client above escrow on Partial and Fail jobs
};

// ─── Demo / Try-it (SPEC section 7) ───────────────────────────────────────────

export type DemoScenario = 'honest' | 'sloppy' | 'cheater';

/** One step from GET /demo/status/:job_id. Steps are appended as they happen. */
export type DemoStep = {
  name: string;
  status: 'done' | 'running' | 'failed';
  at_ms: number;
  detail?: string;
  tx_url?: string | null;
};

export type DemoStatus = {
  job: JobView | null;
  steps: DemoStep[];
};

export type DemoRun = {
  job_id: number;
  scenario: DemoScenario;
  steps: DemoStep[];
  job: JobView | null;
  status: 'running' | 'done' | 'error';
};

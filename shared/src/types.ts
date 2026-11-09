// Shapes from docs/SPEC.md sections 4.1, 4.5, 5 and 6. Amounts are integer
// token units as decimal strings (U128). Never use floats for money.

export type U128 = string;

export interface Config {
  min_bond: U128;
  reference_value: U128;
  penalty_bps: number;
  client_share_bps: number;
  max_leverage: number;
  base_fee_bps: number;
  loading_milli: number;
  default_min_score_bps: number;
  appeal_window_ms: number;
  appeal_deposit: U128;
  withdraw_cooldown_ms: number;
  max_backers_per_agent: number;
}

export const DEFAULT_CONFIG: Config = {
  min_bond: "100000000",
  reference_value: "50000000",
  penalty_bps: 2000,
  client_share_bps: 5000,
  max_leverage: 8,
  base_fee_bps: 100,
  loading_milli: 1500,
  default_min_score_bps: 5000,
  appeal_window_ms: 120_000,
  appeal_deposit: "5000000",
  withdraw_cooldown_ms: 60_000,
  max_backers_per_agent: 20,
};

export interface AgentView {
  agent_id: string;
  bond: U128;
  pool_total: U128;
  backers: { backer_id: string; amount: U128 }[];
  open_exposure: U128;
  weighted_jobs: U128;
  weighted_failures: U128;
  failure_rate_bps: number;
  premium_bps: number;
  jobs_passed: number;
  jobs_partial: number;
  jobs_failed: number;
  registered_ms: number;
}

export const JOB_STATUSES = [
  "Open",
  "Accepted",
  "Delivered",
  "Judged",
  "Appealed",
  "Settled",
  "Cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export type Outcome = "Pass" | "Partial" | "Fail";

export interface Settlement {
  outcome: Outcome;
  to_agent: U128;
  to_client: U128;
  to_pool: U128;
  from_bond: U128;
  from_pool: U128;
  settled_ms: number;
}

export interface JobView {
  job_id: number;
  client_id: string;
  value: U128;
  spec_hash: string;
  spec_url: string;
  min_score_bps: number;
  deadline_ms: number;
  posted_ms: number;
  status: JobStatus;
  agent_id: string | null;
  premium_bps: number | null;
  patch_url: string | null;
  patch_hash: string | null;
  verdict: null | {
    score_bps: number;
    checks_passed: number;
    checks_total: number;
    receipts_hash: string;
    judged_ms: number;
    appeal_deadline_ms: number;
  };
  appeal: null | { appellant_id: string; deposit: U128; original_score_bps: number };
  settlement: null | Settlement;
}

// ---- Job spec (SPEC section 5) ----

export interface TestCheck {
  id: string;
  type: "test";
  name: string;
}
export interface AiCheck {
  id: string;
  type: "ai";
  question: string;
}
export type Check = TestCheck | AiCheck;

export interface JobSpec {
  title: string;
  description: string;
  repo_path: string;
  test_command: string;
  allowed_paths: string[];
  checks: Check[];
  min_score_bps: number;
}

// ---- Judge output (SPEC section 6) ----

export interface AiVote {
  model: string;
  pass: boolean;
  reason: string;
  attestation_verified: boolean;
  signature_verified: boolean;
  problems: string[];
}

export type CheckResult =
  | { id: string; type: "test"; name: string; pass: boolean }
  | { id: string; type: "ai"; question: string; pass: boolean; votes: AiVote[] };

export interface Verdict {
  job_id: number;
  spec_hash: string;
  patch_hash: string;
  checks: CheckResult[];
  checks_passed: number;
  checks_total: number;
  score_bps: number;
  isolation: "docker" | "tempdir";
  problems: string[];
  judged_at_ms: number;
}

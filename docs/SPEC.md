# Surety — Shared Technical Spec

**Every developer and every AI coding agent follows this file.** It defines how the
contract, the backend and the frontend talk to each other. If you need to change
anything here, tell the other two first, agree, then update this file in the same
pull request as the code.

Rules and formulas (who pays what, prices) live in [`MECHANISM.md`](../MECHANISM.md).
This file covers names, data shapes and method signatures.

---

## 1. Fixed facts

| Item | Value |
|---|---|
| Hackathon deadline | 2026-11-14 23:59 UTC (we submit on 2026-11-13) |
| Network | NEAR **testnet only**. Never mainnet, never real funds. |
| Repository | One repo, `surety`. Folders below. |
| Node.js | v20 or newer (npm workspaces) |
| Rust | stable, `near-sdk` 5.x, built with `cargo-near` |
| Token decimals | 6 (like USDC). `1 tUSDC = 1_000_000` units |
| Amounts | Always integer token units. In JSON: **strings** (`"50000000"`). Rust: `U128`. TS: `string`, convert with `BigInt`. **Never floats.** |
| Percentages | Basis points (bps): `10000 = 100%`. Integers. |
| Time | Milliseconds since epoch (`u64` / `number`), named `*_ms` |
| Hashes | SHA-256, lowercase hex, 64 chars |

---

## 2. Repository layout and owners

```
surety/
  README.md             Dev 3 (everyone reviews)
  MECHANISM.md          everyone (agreed day 1)
  LICENSE               MIT
  .env.example          Dev 2 (names only, never values)
  package.json          npm workspaces: shared, judge, agents, sim, web
  docs/SPEC.md          this file
  contract/             Dev 1  Surety contract (Rust)
  token/                Dev 1  mock stablecoin tUSDC (Rust, NEP-141)
  scripts/              Dev 1  setup-testnet.mjs, deploy.mjs, demo.mjs
  deployments/          Dev 1  testnet.json (public account ids only)
  shared/               Dev 2  types.ts, pricing.ts, test-vectors.json, near.ts
  judge/                Dev 2  judge service + demo HTTP API
  agents/               Dev 2  scripted agents, demo job repo, job specs, patches
  receipts/             Dev 2  published verdict + attestation receipts
  sim/                  Dev 3  simulation
  web/                  Dev 3  dashboard
```

**Only edit folders you own.** Need a change in someone else's folder? Ask them,
or open a pull request and tag them.

---

## 3. Testnet accounts

One parent account per team, created once by Dev 1. Name it in `.env` as
`NEAR_PARENT` (example: `surety-team.testnet`). Every other account is a
sub-account:

| Account | Role | Keys used day to day |
|---|---|---|
| `core.<parent>` | Surety contract | — |
| `tusdc.<parent>` | mock stablecoin | — |
| `judge.<parent>` | judge service | function-call key: `submit_verdict`, `settle` only |
| `panel.<parent>` | appeal panel | full access (team holds it) |
| `client.<parent>` | demo client | full access (it deposits tokens) |
| `honest-agent.<parent>` | demo agent, good work | function-call key: `register_agent`, `accept_job`, `deliver` |
| `sloppy-agent.<parent>` | demo agent, broken work | same as above |
| `cheater-agent.<parent>` | self-dealing agent (posts jobs to itself) | same as above |
| `fake-client-1.<parent>` … `fake-client-3.<parent>` | the cheater's sock puppets | full access |
| `backer.<parent>` | demo backer | full access |

Bonds, pool deposits and job payments go through `ft_transfer_call`, which needs
a 1 yoctoNEAR deposit, so those use full-access keys **once during setup or
in the demo client**. Day-to-day agent and judge actions use the restricted
function-call keys. This is documented in the README.

All public account ids are written by `scripts/setup-testnet.mjs` into
`deployments/testnet.json` (committed). Private keys go only into `.env`
(git-ignored).

---

## 4. Contract interface (`core.<parent>`)

### 4.1 Init

```rust
#[init]
fn new(token_id: AccountId, judge_id: AccountId, panel_id: AccountId, config: Config) -> Self
```

```jsonc
// Config (all values configurable, defaults below)
{
  "min_bond": "100000000",          // 100 tUSDC
  "reference_value": "50000000",    // 50 tUSDC, used by the price prior
  "penalty_bps": 2000,              // 20% of job value on a fail
  "client_share_bps": 5000,         // share of the penalty paid to the client; rest to backers
  "max_leverage": 8,                // open exposure <= max_leverage * bond (must stay < 10, see MECHANISM §5)
  "base_fee_bps": 100,              // 1%
  "loading_milli": 1500,            // 1.5x
  "default_min_score_bps": 5000,
  "appeal_window_ms": 120000,       // 2 min for the demo (24h in production)
  "appeal_deposit": "5000000",      // 5 tUSDC
  "withdraw_cooldown_ms": 60000,
  "max_backers_per_agent": 20
}
```

`client_share_bps` and `max_leverage` implement the anti-collusion rule from
MECHANISM.md. To switch it off, set `client_share_bps: 10000` and a large
`max_leverage`.

### 4.2 Money in: `ft_on_transfer`

Users call `ft_transfer_call` on `tusdc.<parent>` with `receiver_id = core.<parent>`
and a JSON `msg`. Exactly one of:

```jsonc
{ "action": "bond" }                                   // sender must be a registered agent
{ "action": "pool", "agent_id": "honest-agent.x.testnet" }
{ "action": "post_job", "spec_hash": "<hex>", "spec_url": "<url or repo path>",
  "min_score_bps": 5000, "deadline_ms": 1763000000000 }
{ "action": "appeal", "job_id": 7 }                    // amount must equal config.appeal_deposit
```

Returns `U128("0")` on success (all tokens kept). On a bad `msg` it panics so the
token contract refunds.

### 4.3 Change methods

| Method | Caller | Args | Effect |
|---|---|---|---|
| `register_agent` | agent | — | Creates agent record (bond 0) |
| `accept_job` | agent | `job_id: u64` | Job must be `Open`, not expired. Checks bond ≥ `min_bond` and exposure rule. Locks `premium_bps` at the agent's current price. → `Accepted` |
| `deliver` | assigned agent | `job_id, patch_url: String, patch_hash: String` | → `Delivered` |
| `submit_verdict` | `judge_id` only | `job_id, score_bps: u16, checks_passed: u16, checks_total: u16, receipts_hash: String` | Job must be `Delivered`. Once only. Starts appeal window. → `Judged` |
| `resolve_appeal` | `panel_id` only | `job_id, score_bps: u16` | Job must be `Appealed`. Sets final score; deposit to winner (see MECHANISM). → `Judged` with window closed |
| `settle` | anyone | `job_id` | `Judged` and window over (or appeal resolved). Pays out per MECHANISM. Once only. → `Settled` |
| `cancel_expired` | client | `job_id` | `Open`: refund client. `Accepted` past deadline: settle as score 0 (fail). → `Cancelled` / `Settled` |
| `withdraw_bond` | agent | `amount: U128` | Only if open exposure = 0 and cooldown passed. Must leave 0 or ≥ `min_bond` |
| `withdraw_pool` | backer | `agent_id, amount: U128` | Same lock as above |

All payouts use `ft_transfer` from the contract to the receiver (1 yocto attached).
Every receiver must be registered on the token (`storage_deposit`); the setup
script registers all demo accounts.

### 4.4 View methods

| Method | Returns |
|---|---|
| `get_config()` | `Config` |
| `get_agent(agent_id)` | `AgentView` or `null` |
| `list_agents(from_index: u64, limit: u64)` | `AgentView[]` |
| `get_job(job_id)` | `JobView` or `null` |
| `list_jobs(from_index: u64, limit: u64)` | `JobView[]` (newest first) |
| `list_jobs_by_status(status: String, limit: u64)` | `JobView[]` (the judge polls `"Delivered"`) |
| `get_price(agent_id)` | `{ "premium_bps": u32, "failure_rate_bps": u32 }` |

### 4.5 JSON shapes (TypeScript, mirrored in `shared/types.ts`)

```ts
type U128 = string;

interface AgentView {
  agent_id: string;
  bond: U128;
  pool_total: U128;
  backers: { backer_id: string; amount: U128 }[];
  open_exposure: U128;
  weighted_jobs: U128;      // N_w
  weighted_failures: U128;  // F_w
  failure_rate_bps: number;
  premium_bps: number;
  jobs_passed: number;
  jobs_partial: number;
  jobs_failed: number;
  registered_ms: number;
}

type JobStatus = "Open" | "Accepted" | "Delivered" | "Judged" | "Appealed" | "Settled" | "Cancelled";

interface JobView {
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
  premium_bps: number | null;      // locked at accept
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
  settlement: null | {
    outcome: "Pass" | "Partial" | "Fail";
    to_agent: U128;
    to_client: U128;
    to_pool: U128;          // premium (pass/partial) or backers' share of penalty (fail)
    from_bond: U128;        // penalty taken from bond
    from_pool: U128;        // penalty shortfall taken from pool
    settled_ms: number;
  };
}
```

### 4.6 Events

The contract logs NEP-297 events so the dashboard can show a live feed:

```
EVENT_JSON:{"standard":"surety","version":"1.0.0","event":"<name>","data":[{...}]}
```

Names: `agent_registered`, `bond_deposited`, `pool_deposited`, `job_posted`,
`job_accepted`, `job_delivered`, `verdict_submitted`, `job_appealed`,
`appeal_resolved`, `job_settled`, `job_cancelled`, `withdrawn`.
`data[0]` always includes `job_id` and/or `agent_id` plus the amounts involved.

---

## 5. Job spec (off-chain, hashed on-chain)

Stored as JSON in `agents/jobs/<slug>.json`. `spec_hash` = SHA-256 of the file's
exact bytes. `spec_url` = repo-relative path (`agents/jobs/login-bug.json`) or,
once the repo is public, its raw GitHub URL.

```jsonc
{
  "title": "Fix the login bug",
  "description": "Login accepts an empty password. Reject it with error EMPTY_PASSWORD.",
  "repo_path": "agents/demo-repo",        // the code the agent must change
  "test_command": "npm test --silent",
  "allowed_paths": ["src/auth/"],
  "checks": [
    { "id": "t1", "type": "test", "name": "rejects empty password" },
    { "id": "t2", "type": "test", "name": "accepts valid password" },
    { "id": "t3", "type": "test", "name": "returns EMPTY_PASSWORD code" },
    { "id": "t4", "type": "test", "name": "locks after 5 failed attempts" },
    { "id": "t5", "type": "test", "name": "existing session tests still pass" },
    { "id": "a1", "type": "ai", "question": "Did the patch change only files under src/auth/?" },
    { "id": "a2", "type": "ai", "question": "Does the patch do what the description asks, without unrelated changes?" }
  ],
  "min_score_bps": 5000
}
```

A patch is a unified diff file (`agents/patches/<agent>-<slug>.diff`).
`patch_hash` = SHA-256 of its bytes.

---

## 6. Judge output (`receipts/<job_id>/`)

```
receipts/<job_id>/
  verdict.json          the result (below)
  tests.json            each test check: name, pass, output excerpt
  judge-<model>.json    per model: request, raw response, attestation, verification result
```

```jsonc
// verdict.json — receipts_hash = SHA-256 of this file's bytes
{
  "job_id": 7,
  "spec_hash": "…", "patch_hash": "…",
  "checks": [
    { "id": "t1", "type": "test", "pass": true },
    { "id": "a1", "type": "ai", "pass": false,
      "votes": [ { "model": "…", "pass": false, "reason": "…", "attestation_verified": true }, … ] }
  ],
  "checks_passed": 5, "checks_total": 7, "score_bps": 7142,
  "judged_at_ms": 1763000000000
}
```

`score_bps = floor(checks_passed * 10000 / checks_total)`.
An AI check passes when **at least 2 of 3** models say pass **and** their
attestations verified. A model whose attestation fails to verify counts as a
fail vote and is flagged in the receipt.

---

## 7. Demo HTTP API (`judge/`, for the dashboard's Try-it button)

Base URL in `VITE_DEMO_API_URL`. Holds demo account keys server-side.
Rate limit: 1 run at a time, 10 per hour.

| Route | Effect |
|---|---|
| `GET /health` | `{ ok: true, contract_id }` |
| `POST /demo/run` body `{ "scenario": "sloppy" \| "honest" \| "cheater" }` | Posts a job, the scripted agent accepts and delivers, judge runs. Returns `{ job_id }` immediately |
| `GET /demo/status/:job_id` | `{ job, steps: [{ name, status, at_ms, detail }] }` for a live progress panel |
| `GET /receipts/:job_id/:file` | serves files from `receipts/` |

---

## 8. Environment variables (`.env.example`)

```
NEAR_NETWORK=testnet
NEAR_RPC_URL=            # pick from https://docs.near.org/api/rpc/providers
NEAR_PARENT=             # e.g. surety-team.testnet
SURETY_CONTRACT_ID=
TOKEN_ID=
JUDGE_ACCOUNT_ID=
JUDGE_PRIVATE_KEY=       # function-call key: submit_verdict, settle
PANEL_PRIVATE_KEY=
CLIENT_PRIVATE_KEY=
HONEST_AGENT_PRIVATE_KEY=
SLOPPY_AGENT_PRIVATE_KEY=
CHEATER_AGENT_PRIVATE_KEY=
BACKER_PRIVATE_KEY=
NEARAI_BASE_URL=https://cloud-api.near.ai/v1
NEARAI_API_KEY=
JUDGE_MODELS=            # 3 model ids from GET /v1/models, comma-separated
DEMO_API_PORT=8787

# web/ (Vite)
VITE_NEAR_NETWORK=testnet
VITE_RPC_URL=
VITE_CONTRACT_ID=
VITE_TOKEN_ID=
VITE_DEMO_API_URL=http://localhost:8787
```

---

## 9. Shared pricing check

`shared/test-vectors.json` holds 15+ cases: `{ inputs, expected }` for
`failure_rate_bps`, `premium_bps`, `job_weight` and each settlement outcome.
**Dev 1's Rust tests and Dev 2's TypeScript tests both load this file.** If the
two implementations ever disagree, the build fails. Dev 1 and Dev 2 write the
vectors together on day 1.

---

## 10. Team rules

1. Testnet only. No mainnet transactions, no real money.
2. Never commit private keys, seed phrases, API keys or `.env`. Check `git diff` before every commit.
3. One branch per person (`dev1/...`, `dev2/...`, `dev3/...`); merge to `main` by pull request; `main` must always build.
4. Don't make the repo public, push to someone else's branch, or post on X without the team agreeing.
5. Verify every endpoint, model id, package version and API shape in the official docs before using it. Don't guess.
6. If something in this spec is wrong or blocks you, say so in the team chat before working around it.
7. Feature freeze: end of Tue 11 Nov. After that, only bug fixes, tests, docs and the demo.

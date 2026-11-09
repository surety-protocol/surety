# Prompt — Dev 2: Backend, AI Judges and Agents

> Paste everything below the line into your AI coding agent (Claude Code or Codex),
> opened at the root of the `surety` repo.

---

You are my pair programmer for **Surety**, our team's entry to NEAR HACKATHON 2026
(deadline 14 Nov 2026, 23:59 UTC; we submit 13 Nov). We are three developers.
**I am Dev 2: I own the judge service, the AI judges, the demo agents and the shared
TypeScript code.** Dev 1 owns the smart contracts. Dev 3 owns the dashboard,
simulation and README.

## What Surety is

An on-chain insurance market for AI coding agents. An agent locks a bond in our
NEAR contract. A client posts a coding job and pays into escrow. The agent
delivers a patch. **My judge service** runs the client's tests on the patch and
asks three AI judges on NEAR AI Cloud (open models running inside TEEs, each reply
backed by a hardware attestation). It publishes receipts and sends the verdict to
the contract, which pays out. The judge is the part that makes money move, so it
must be correct, reproducible and verifiable.

## Read these first, fully, before writing any code

1. `docs/SPEC.md` — the interface. **Sections 4.5 (JSON shapes), 5 (job spec), 6 (judge output), 7 (demo API), 8 (env) are mine to implement or consume.**
2. `MECHANISM.md` — formulas for `shared/pricing.ts`.
3. `https://nearhackathon.com/HACKATHON.md` — hackathon rules.
4. NEAR AI Cloud — read, don't assume:
   - Quickstart: https://docs.near.ai/cloud/quickstart
   - Verification (attestation): https://docs.near.ai/cloud/verification
   - Example repo: https://github.com/near-examples/nearai-cloud-verification-example
   - Credits and API key: https://cloud.near.ai (free $10 via https://nearbuilders.org/join)
5. `near-api-js` docs for calling contracts from Node (check the current package names and versions).

If anything in SPEC.md is ambiguous or doesn't match how NEAR AI Cloud actually
works, **stop and tell me** with a proposed fix.

## Folders I own (only edit these)

`shared/`, `judge/`, `agents/`, `receipts/`, `.env.example`. Plus
`shared/test-vectors.json` jointly with Dev 1.

## Deliverables

### A. `shared/` (other folders import this — build it first)

- `types.ts`: the exact TS types from SPEC §4.5 and §6.
- `pricing.ts`: pure functions from MECHANISM §3–§4 using `bigint` only: `jobWeight`, `failureRateBps`, `premiumBps`, `settle(outcome inputs) → amounts`. No floats anywhere.
- `test-vectors.json` (with Dev 1) + `pricing.test.ts` that loads it. Must match Dev 1's Rust results exactly.
- `near.ts`: small helpers: view call, function call with a given key, read `deployments/testnet.json`.
- `hash.ts`: SHA-256 hex of file bytes.

### B. `agents/` — demo material (scripted, reproducible)

- `demo-repo/`: a tiny Node.js project (an auth module with a real login bug) and a test suite whose test **names exactly match** the `test` checks in the job spec. Tests run with `npm test`, no network.
- `jobs/login-bug.json`: the job spec from SPEC §5.
- `patches/honest-login-bug.diff` (passes all checks), `patches/sloppy-login-bug.diff` (fails 3 tests **and** edits a file outside `src/auth/`), plus an easy patch and job for the cheater's self-dealt jobs.
- `run-agent.ts --agent honest|sloppy|cheater --job <id>`: registers if needed, accepts, delivers the patch (url + hash) using that agent's **function-call key** from `.env`.

Test the patches for real: apply them, run the tests, confirm the expected failures.
Never fake a result.

### C. `judge/` — the judge service (Node.js + TypeScript, no database)

Loop:

1. Poll `list_jobs_by_status("Delivered")` every few seconds.
2. For each job: fetch the spec and patch; check both hashes match what is on-chain (mismatch → score 0, reason recorded).
3. **Tests:** copy `repo_path` into a fresh temp folder, `git apply` the patch, run `test_command` with a timeout (2 min), no network if possible, parse results per test name. If Docker is available use it (`--network none`); otherwise run in the temp folder and say so in the receipt. Never run a patch in the real repo folder.
4. **AI checks:** for each `ai` check, call the 3 models in `JUDGE_MODELS` via the OpenAI-compatible API at `NEARAI_BASE_URL`. Give each the job description, the check question, `allowed_paths`, the diff and the test results. Require strict JSON: `{"pass": boolean, "reason": string}` (validate with zod; one retry on bad JSON, then count as fail). Temperature 0.
5. **Attestation:** for each model call, fetch and verify the attestation with a fresh random nonce, exactly as the verification docs and example repo do. Record what was checked. Unverified → that vote counts as fail and is flagged.
6. Combine: AI check passes on ≥ 2 of 3 verified votes. `score_bps = floor(passed * 10000 / total)`.
7. Write `receipts/<job_id>/verdict.json`, `tests.json`, `judge-<model>.json` (SPEC §6). `receipts_hash` = SHA-256 of `verdict.json`.
8. Call `submit_verdict` with the judge's **function-call key**. Then, after the appeal window, call `settle` (anyone may call it).

Pick the 3 models on day 1 from `GET /v1/models`: one each from different labs
(for example DeepSeek, GLM, Kimi). **Skip any "abliterated" variant.** Put the
exact ids in `.env.example` comments and the README.

Also in `judge/`: the **demo HTTP API** from SPEC §7 (Express or Fastify), rate
limited, CORS for the dashboard origin, keys stay server-side. `POST /demo/run`
drives `run-agent.ts` + the judge for one scenario and reports step-by-step status.

Tests: unit tests for vote combining, score math, hash checks, JSON validation,
and the test-result parser; one recorded end-to-end test using saved model
responses (so it runs without API credits).

## Day-by-day (end-of-day check in brackets)

- **Sun 9 Nov:** read the docs; claim NEAR AI credits; **one script that sends one completion and verifies its attestation, printed output**; `shared/types.ts`; test vectors with Dev 1. *[Verified attestation printed; types merged]*
- **Mon 10 Nov:** `pricing.ts` + tests passing on the vectors; demo repo, job spec, both patches verified by hand; test runner in temp folders. *[`judge` scores the honest patch 5/5 tests and the sloppy one 2/5 locally]*
- **Tue 11 Nov:** 3-model voting, receipts, `submit_verdict` + `settle` against Dev 1's testnet contract; `run-agent.ts`. *[Full job judged and settled on testnet. FEATURE FREEZE]*
- **Wed 12 Nov:** demo HTTP API for Dev 3; cheater scenario; recorded end-to-end test; error handling and logs; bug fixes. *[Dashboard's Try-it button runs a full job]*
- **Thu 13 Nov:** clean-machine test with the team; fix only what breaks; help with the video.
- **Fri 14 Nov:** spare.

If you fall behind, drop in this order: Docker isolation → cheater scenario →
third model (two models, both must agree) → demo HTTP API (CLI demo only). Never
drop: tests as the main check, at least one verified NEAR AI Cloud judge,
receipts, `submit_verdict`.

## Rules

- Testnet only. Never sign mainnet transactions or move real funds.
- Never commit keys, API keys or `.env`. Check `git diff` before every commit. Receipts must not contain API keys or headers.
- The judge key must be a function-call key limited to `submit_verdict` and `settle`. Never use a full-access key in the judge.
- Work on branch `dev2/...`; merge to `main` by pull request. Don't push or force-push without asking me.
- Ask me before installing anything globally or spending more than the free API credits.

## How to start

1. Read the sources above.
2. Reply with: (a) anything unclear or risky in SPEC/MECHANISM, (b) how NEAR AI Cloud attestation verification actually works according to the docs (what is checked, which endpoint, what the nonce binds), (c) your folder layout and the npm packages and versions you plan to use.
3. **Wait for my OK**, then build the one-call attestation script first and show me its output.

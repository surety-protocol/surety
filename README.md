# Surety

**Insurance for AI coding agents on NEAR.** Agents put their own money on the line,
tests and three verifiable AI judges check the work, and a failed job refunds the
client automatically.

[![CI](https://github.com/surety-protocol/surety/actions/workflows/ci.yml/badge.svg)](https://github.com/surety-protocol/surety/actions/workflows/ci.yml)

- **Live dashboard:** <https://surety-beige.vercel.app> (reads the testnet contract directly)
- **Contract on testnet:** [`core.surety.testnet`](https://testnet.nearblocks.io/address/core.surety.testnet), token [`tusdc.surety.testnet`](https://testnet.nearblocks.io/address/tusdc.surety.testnet)
- **Demo video / X post:** _links added at submission_

Built at NEAR HACKATHON 2026.

## The problem

AI coding agents are starting to take paid work. When one ships a broken patch,
the client has already paid and has no recourse. And there's no honest price
signal: a careless agent and a careful one look the same until it is too late.

## What Surety does

1. A client posts a job with a spec, and the payment goes into escrow in the contract.
2. A bonded agent accepts it at a premium set by its own track record.
3. The judge service runs the client's tests on the patch. Then three AI models,
   each running in a TEE on NEAR AI Cloud, vote on the questions tests can't answer.
4. The verdict goes on chain with a hash of the attestation receipts. After a
   2-minute appeal window, the contract settles the job by itself:
   - **Pass:** the agent gets the escrow minus the premium.
   - **Fail:** the client gets the escrow back plus a penalty from the agent's bond.
5. The agent's premium for its next job moves with its record.

The rules and formulas are in [`MECHANISM.md`](MECHANISM.md).

## See it working (no setup)

- **Dashboard → Jobs:** every job on the testnet contract. Open one to see each
  check, every AI judge's vote and reason with its TEE attestation status, and the
  settlement breakdown.
- **A real run:** testnet jobs 4–7 were judged by the real NEAR AI models. Their
  receipts are in [`receipts/`](receipts/):

  | Job | Scenario | Result |
  |---|---|---|
  | 4 | sloppy agent | **Fail**, 2/7 checks. The client got 60 tUSDC back: 50 escrow + 10 from the agent's bond |
  | 6 | cheater (sock-puppet client) | **Pass**, 1/1 check. See [Known limitations](#known-limitations) |
  | 7 | honest agent | **Pass**, 7/7 checks. All six AI votes are attestation- and signature-verified |

  Job 5 is an honest run that lost a check to a judge bug: two models ran out
  of tokens before answering. We kept it on record and fixed the bug before job 7.

## Run it yourself

Needs Node 20+ and Rust (for the contract build). Run everything from the repo root.

**Without any accounts:**

```bash
npm install
npm test               # contract-pricing vectors, judge, agents, sim
npm run sim            # the market simulation and its findings
npm run web            # dashboard on http://localhost:5173 (mock data by default)
```

**On your own testnet account** (about 20 testnet NEAR, plus a NEAR AI Cloud
key with a little credit):

1. `cp .env.example .env`. Then fill in `NEAR_PARENT`, `NEAR_PARENT_PRIVATE_KEY`,
   `NEAR_RPC_URL` (e.g. `https://test.rpc.fastnear.com`) and `NEARAI_API_KEY`.
2. `npm run setup:testnet`: creates the 12 sub-accounts and restricted keys.
3. `npm run deploy`: builds, deploys and initialises the contract and the token,
   and mints demo tUSDC.
4. `npm run testnet:smoke`: runs one job end to end with no AI. It should end with
   `Pass: agent got 46.50, client got 0.00, pool got 3.50 tUSDC`.
5. `npm run judge-demo`: runs the sloppy, honest and cheater scenarios with the
   real AI judges. Every step is printed with its explorer link, for example:

   ```
   ── sloppy ──
     ✓ tests done: 2/5 passed
     ✓ AI judges done: a1:fail a2:fail
     ✓ verdict submitted: 2/7 checks, score 28.57%
     → job 4: 2/7 checks, Fail. agent 0.00, client 60.00, pool 0.00 tUSDC
   ```

More detail is in [`scripts/README.md`](scripts/README.md).

### Try it in the dashboard

Start the judge service with `npm run judge`, and the dashboard with `npm run web`
and `VITE_USE_MOCK=false` in `web/.env.local`. Then:

- **Try It → Sloppy agent:** the steps appear live, and the job ends **Fail** with the client refunded.
- **Try It → Honest agent:** it ends **Pass**. The agent is paid, and its premium for the next job goes down.
- **Agents:** each agent's bond, record and premium over time.

The hosted dashboard can't reach a judge running on your machine, so Try It works
only locally.

## NEAR features used, and where

| Feature | Where |
|---|---|
| Smart contract (Rust, near-sdk): bonds, escrow, pricing, verdicts, appeals, settlement | [`contract/src/`](contract/src/) |
| NEP-141 fungible token (tUSDC) with `ft_transfer_call` for bonds, jobs and appeals | [`token/src/lib.rs`](token/src/lib.rs), `ft_on_transfer` in [`contract/src/lib.rs`](contract/src/lib.rs) |
| NEP-297 events for every state change | [`contract/src/events.rs`](contract/src/events.rs) |
| Function-call access keys: the judge key can only call `submit_verdict` and `settle`; agent keys only `register_agent`, `accept_job` and `deliver` | [`scripts/setup-testnet.mjs`](scripts/setup-testnet.mjs) |
| Named sub-accounts for every role (`judge.`, `client.`, `honest-agent.` …) | [`scripts/setup-testnet.mjs`](scripts/setup-testnet.mjs), [`deployments/testnet.json`](deployments/testnet.json) |
| NEAR AI Cloud: three models from three labs (DeepSeek, GLM, Qwen) | [`judge/src/ai-panel.ts`](judge/src/ai-panel.ts), [`judge/src/config.ts`](judge/src/config.ts) |
| TEE attestation (Intel TDX quote + NVIDIA GPU evidence) and per-response signatures, checked before a vote counts | [`judge/src/nearai/attestation.ts`](judge/src/nearai/attestation.ts), [`judge/src/nearai/signature.ts`](judge/src/nearai/signature.ts) |
| RPC client for transactions and views (near-api-js 7) | [`shared/src/near.ts`](shared/src/near.ts), [`scripts/lib/near.mjs`](scripts/lib/near.mjs) |

## Known limitations

**Sock-puppet clients can lower an agent's price.** An agent can hire itself
through fake client accounts, deliver easy work that passes, and so lower its
measured failure rate and its premium. Repeat clients already count less
(each job weighs value/k, where k is the number of jobs that client has had
with that agent), but that is not enough:

- In our simulation, over 50 random seeds, an agent at 30% true failure with
  3 sock puppets came out ahead in 34 of 50 runs (median +491 tUSDC). The
  lower price won it about 18 extra jobs.
- We tested two rule changes. Neither stopped it:
  - **A:** an agent without backers pays its premium to a protocol reserve
    instead of its own bond. Cheating still paid in 35 of 50 runs (median
    +405 tUSDC).
  - **B:** repeat clients count value/k² instead of value/k. The cheater was
    still priced below its honest peers in 34 of 50 runs (38 under current
    rules).
- The contract keeps the current rules. Clients and backers should treat a
  failure rate built mostly on a few repeat clients with caution.
- A proper fix needs sybil resistance, for example weighting each client by
  how much it spends with *other* agents. That is planned after the hackathon.

Collusion between an agent and a client who rubber-stamps its work, by
contrast, lost money in all 50 runs. Full results and method:
[`sim/README.md`](sim/README.md#robustness-across-seeds).


**The judge service runs on our server.** The AI votes are verifiable: each one
comes from a TEE-attested model and carries its own signature, and the receipts
are published with their hash on chain. But the test runner, and the code that
combines the votes into a score, run on an ordinary server holding the judge key.
That key can only call `submit_verdict` and `settle`, and the client or the
agent can appeal a verdict within the appeal window. The next step is to run the whole judge inside
a TEE as well.

**Testnet only.** tUSDC is a test token with no value, and the contract has not
been audited.

## Tech stack

- **Contract and token:** Rust, near-sdk, built to wasm (`npm run contract:build`)
- **Judge, agents and shared library:** TypeScript on Node 22/24, near-api-js 7, ethers (response signatures)
- **Dashboard:** React 19, Vite 8, Tailwind 4, Recharts, hosted on Vercel
- **Simulation:** TypeScript, using the same pricing module as the contract (`shared/pricing.ts`, checked against `shared/test-vectors.json`)
- **CI:** GitHub Actions. Node tests on Ubuntu and Windows, plus the Rust contract tests

## AI-assisted code (hackathon rule Q-005)

We used AI coding assistants throughout and reviewed and tested what they wrote:

- **Claude Code (Anthropic)** wrote most of the TypeScript backend: `shared/`,
  `judge/` and `agents/`. It also ported the testnet scripts in `scripts/` to
  near-api-js 7, wrote parts of this README and the dashboard fixes, and ran the
  testnet deployment.
- The rest of the repo (`contract/`, `token/`, `web/`, `sim/`) was written with
  AI assistance too. Every change went through pull requests, CI and team review.

The rules for AI agents working in this repo are in [`AGENTS.md`](AGENTS.md) and
[`CLAUDE.md`](CLAUDE.md). The mechanism, the specs and every design decision are
the team's own.

## Team

- **Osuochasam:** contract, token, testnet scripts
- **N-thnI:** backend, AI judges, attestation
- **Abd-Standard:** dashboard, simulation, story

For contributors: start with [`prompts/README.md`](prompts/README.md), then
[`docs/SPEC.md`](docs/SPEC.md) (interfaces) and [`MECHANISM.md`](MECHANISM.md) (rules).

## License

MIT, see [LICENSE](LICENSE).

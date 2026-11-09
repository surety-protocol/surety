# Prompt — Dev 1: Blockchain and Smart Contracts

> Paste everything below the line into your AI coding agent (Claude Code or Codex),
> opened at the root of the `surety` repo.

---

You are my pair programmer for **Surety**, our team's entry to NEAR HACKATHON 2026
(deadline 14 Nov 2026, 23:59 UTC; we submit 13 Nov). We are three developers.
**I am Dev 1: I own the smart contracts, the token and the testnet setup.**
Dev 2 owns the backend and AI judges. Dev 3 owns the dashboard, simulation and README.

## What Surety is

An on-chain insurance market for AI coding agents. An agent locks a bond in our
NEAR contract. A client posts a coding job and pays into escrow. The agent
delivers a patch. Our judge service runs the client's tests and asks three AI
judges on NEAR AI Cloud (inside TEEs, with attestation). The contract receives the
verdict and settles: pass pays the agent (minus an insurance premium to backers);
fail refunds the client plus compensation taken from the agent's bond first, then
the backers' pool. Each agent's premium is computed from its weighted record, so
price becomes reputation.

## Read these first, fully, before writing any code

1. `docs/SPEC.md` — the interface all three of us build against. **Section 4 is your contract's exact API.**
2. `MECHANISM.md` — every formula you implement (prices, settlement, collusion rule).
3. `https://nearhackathon.com/HACKATHON.md` — hackathon rules.
4. NEAR docs you will need — read them, don't assume:
   - near-sdk (Rust) and `cargo-near`: https://docs.near.org/
   - Fungible tokens (NEP-141, `ft_transfer_call`, `ft_on_transfer`, storage deposits)
   - Access keys and their limits: https://docs.near.org/protocol/accounts-contracts/access-keys
   - Testing with `near-workspaces`
   - RPC providers: https://docs.near.org/api/rpc/providers

If anything in SPEC.md or MECHANISM.md is ambiguous, contradictory or impossible
on NEAR, **stop and tell me** with a proposed fix. Don't silently change it.

## Folders I own (only edit these)

`contract/`, `token/`, `scripts/`, `deployments/`. Plus `shared/test-vectors.json`
jointly with Dev 2.

## Deliverables

### A. `token/` — mock stablecoin `tUSDC`

- NEP-141 using `near-contract-standards` FungibleToken + storage management + metadata (`symbol: "tUSDC"`, `decimals: 6`).
- `mint(account_id, amount)` callable only by the owner (for demo funding).
- Unit tests: mint, transfer, `ft_transfer_call` round trip.

### B. `contract/` — the Surety contract

Implement **exactly** SPEC §4 (init, `ft_on_transfer` actions, change methods,
views, JSON shapes, events) and MECHANISM §2–§6.

Requirements:

- `ft_on_transfer` must reject calls not coming from the configured `token_id`.
- `new()` rejects a config where `max_leverage * penalty_bps * client_share_bps >= 100_000_000`.
- Integer math only (`u128`), checked arithmetic, round down as MECHANISM says. Never create or lose tokens: write an invariant test that the contract's token balance always equals the sum of all bonds + pools + escrowed job values + appeal deposits.
- Payouts via cross-contract `ft_transfer` with 1 yocto. Handle a failed transfer callback (log an event and keep the amount claimable; don't lose it).
- Store k (jobs per agent–client pair) for the weighting in MECHANISM §3.1.
- Status transitions exactly as SPEC §4.3; every other transition panics with a clear message.
- Emit the NEP-297 events in SPEC §4.6.
- Views return the exact JSON shapes in SPEC §4.5 (Dev 2 and Dev 3 code against them).

Tests (all must pass; this is what judges' AI screeners will run):

- Unit tests for every formula, loading `../shared/test-vectors.json`.
- One unit test per rule in MECHANISM: exposure cap, leverage cap, min bond, self-hire blocked, withdrawal lock + cooldown, judge-only verdict, verdict once, settle once, appeal window, appeal deposit outcome, cancel expired.
- `near-workspaces` integration tests: full job pass, partial, fail (bond pays), fail where the bond is short (pool pays the rest), collusion scenario showing the colluding pair loses money, cheater weighting.

### C. `scripts/` — testnet setup and demo (Node.js, cross-platform, no bash-only scripts)

Use `near-api-js` (check current docs for the right packages and versions).

- `setup-testnet.mjs`: given `NEAR_PARENT` and its key in `.env`, creates every sub-account in SPEC §3, deploys `tusdc` and `core`, calls `new`, registers storage for all accounts, mints demo balances, adds the **function-call keys** (agents: `register_agent`, `accept_job`, `deliver`; judge: `submit_verdict`, `settle`) with a gas allowance, writes private keys into `.env` and public ids into `deployments/testnet.json`. Safe to re-run.
- `deploy.mjs`: rebuild and redeploy the contract (with a state-reset option for the demo).
- `demo.mjs`: one command that runs the three scenarios end to end against testnet (post job → accept → deliver → wait for Dev 2's judge → settle) and prints each step with explorer links. This becomes `npm run judge-demo`.

### D. Shared with Dev 2: `shared/test-vectors.json`

On day 1, write 15+ cases with Dev 2 (from MECHANISM §3–§4, including the worked
examples and edge cases: zero pool, bond exactly equal to penalty, rounding).

## Day-by-day (end-of-day check in brackets)

- **Sun 9 Nov:** read the docs; install `cargo-near` and NEAR CLI; create the parent testnet account; token done and deployed; test vectors drafted with Dev 2. *[tUSDC on testnet; vectors file merged]*
- **Mon 10 Nov:** contract: init, register, bond/pool/post_job via `ft_on_transfer`, accept, deliver, views, events + unit tests. Deploy to testnet; share the contract id. *[Dev 2 and Dev 3 can call views on testnet]*
- **Tue 11 Nov:** verdict, settle (all three outcomes), pool pro rata, exposure/leverage caps, withdrawals, cancel, appeals + tests. `setup-testnet.mjs` complete. *[Full job settles on testnet. FEATURE FREEZE]*
- **Wed 12 Nov:** integration tests, invariant test, `demo.mjs`, function-call keys verified (show that the agent key **cannot** withdraw), bug fixes. *[Someone else runs setup + demo from the README and it works]*
- **Thu 13 Nov:** clean-machine test with the team, fix only what breaks, help with the video.
- **Fri 14 Nov:** spare.

If you fall behind, drop in this order: appeals → `withdraw_pool` → cheater weighting
(keep the field, weight = value). Never drop: bond, escrow, verdict, settlement, loss
order, tests.

## Rules

- Testnet only. Never sign mainnet transactions or move real funds.
- Never commit keys, seed phrases or `.env`. Check `git diff` before every commit.
- Work on branch `dev1/...`; merge to `main` by pull request. Don't push or force-push without asking me.
- Ask me before installing anything globally.
- Explain the limits of function-call keys in `contract/README.md` (they can't attach deposits, can't transfer tokens, run out of gas allowance).

## How to start

1. Read the four sources above.
2. Reply with: (a) a list of anything unclear or risky in SPEC/MECHANISM, (b) your Rust module layout for `contract/`, (c) the exact crate and npm package versions you plan to use, confirmed from the docs.
3. **Wait for my OK**, then build `token/` first.

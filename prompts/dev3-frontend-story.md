# Prompt — Dev 3: Dashboard, Simulation and Story

> Paste everything below the line into your AI coding agent (Claude Code or Codex),
> opened at the root of the `surety` repo.

---

You are my pair programmer for **Surety**, our team's entry to NEAR HACKATHON 2026
(deadline 14 Nov 2026, 23:59 UTC; we submit 13 Nov). We are three developers.
**I am Dev 3: I own the dashboard, the simulation, the README and the demo video.**
Dev 1 owns the smart contracts. Dev 2 owns the judge service, AI judges and
demo agents.

## What Surety is

An on-chain insurance market for AI coding agents. An agent locks a bond in our
NEAR contract. A client posts a coding job and pays into escrow. The agent
delivers a patch. A judge service runs the tests and asks three AI judges on NEAR
AI Cloud (inside TEEs, with attestation). The contract settles: pass pays the
agent minus an insurance premium to backers; fail refunds the client plus
compensation from the agent's bond first, then the backers' pool. Each agent's
premium comes from its record, so price becomes reputation.

**My job is to make that visible and convincing** to the judges: Illia Polosukhin
(NEAR), investors from a16z crypto, Dragonfly, Electric Capital, cyber•Fund,
Synthetix/Infinex and Helius, plus Claude Code and Codex, which screen every repo
first by trying to run it.

## Read these first, fully, before writing any code

1. `docs/SPEC.md` — **§4.4–4.6 (views, JSON shapes, events) and §7 (demo API) are what the dashboard reads.**
2. `MECHANISM.md` — **§7 is the simulation brief.** §3–§5 explain the prices you display.
3. `https://nearhackathon.com/HACKATHON.md` — rules, README expectations, demo post tips.
4. NEAR frontend docs (check current packages and versions; don't assume): https://docs.near.org/ — view calls over RPC, NEAR Wallet Selector.

If anything is unclear, **stop and tell me** with a proposed fix.

## Folders I own (only edit these)

`web/`, `sim/`, `README.md`, `LICENSE`, and the demo video / X post drafts in `docs/`.

## Deliverables

### A. `sim/` — the simulation (build first; it needs no contract)

- TypeScript, imports `shared/pricing.ts` (Dev 2). Until it lands, stub the functions from MECHANISM and swap them in.
- Implements MECHANISM §7 exactly: populations, 500 jobs, fixed seed, no network, no AI calls.
- `npm run sim` writes `sim/out/results.csv`, `sim/out/agents.json` (price and balance per agent per round) and `sim/out/summary.json` with the four findings as checked numbers (each finding `true/false` + the numbers behind it).
- Also outputs static SVG charts into `sim/out/` (for the README).
- If a finding does not hold, **tell me and the team**; we tune `Config` or change the claim. Never massage the output.

### B. `web/` — the dashboard

Vite + React + TypeScript + Tailwind. Reads contract state by RPC view calls
(no backend needed for reading). Contract id and RPC URL from `VITE_*` env.

Pages:

1. **Overview:** one-line pitch, the 3-step "how it works" (post job → agent with money at stake → tests + 3 verifiable judges), live counters (agents, jobs, total bonded, total refunded to clients).
2. **Agents:** table with bond, pool, open exposure, record (passed/partial/failed), premium %, and a price-over-time line per agent (rebuilt from `job_settled` events or job history).
3. **Jobs:** live list with status chips (Open → Accepted → Delivered → Judged → Settled).
4. **Job detail:** spec, checks with pass/fail, each AI judge's vote and reason, a **"Receipts verified"** panel (which models, attestation verified yes/no, links to the receipt files), settlement breakdown (to agent / to client / to pool / from bond), testnet explorer links.
5. **Simulation:** the charts from `sim/out/` with the four findings in plain words.
6. **Try it:** buttons "Run sloppy agent", "Run honest agent", "Run cheater" → `POST /demo/run` on Dev 2's API, then a live step-by-step progress panel (`GET /demo/status/:id`) ending on the job detail. Judges need no wallet.

Wallet connect (NEAR Wallet Selector) is optional: build it only if it is done before the Tue night freeze; otherwise skip it.

Until the contract is on testnet (Mon night), build against **mock data files that
match SPEC §4.5 exactly**, then switch to live RPC with one env flag.

Must work on a laptop screen and a phone. Clear, calm design: no crypto-casino look.
Every number shows its unit (tUSDC, %).

Deploy to Vercel (or Netlify); keep it online until at least 25 Nov.

### C. `README.md` — written for AI screeners and humans

Order:

1. One-sentence summary + demo GIF + links (live dashboard, video, X post).
2. The problem (3 lines). What Surety does (5 lines).
3. **Judge quickstart:** deployed contract ids on testnet; `npm install` then `npm run judge-demo`; what the output should look like, line by line ("sloppy-agent: 2/7 checks, FAIL, client refunded 55 tUSDC").
4. "Try it" steps as **"do X → see Y"**.
5. How it works (diagram) + link to MECHANISM.md.
6. **NEAR features used and where** (file paths): contract, NEP-141 token, function-call keys, named sub-accounts, NEAR AI Cloud + attestation.
7. Limitations stated honestly (the test runner and vote combining run on our server; next step: run the whole judge in a TEE).
8. Tech stack, libraries, and which code was AI-assisted (hackathon rule Q-005).
9. Team, license (MIT).

Add a GitHub Actions workflow badge once Dev 1/Dev 2 tests run in CI.

### D. Demo video and X post (drafts in `docs/`)

- `docs/demo-script.md`: the 75-second shot list — sloppy agent fails, judges agree, receipts verified, client refunded from the bond, price jumps; honest agent passes and gets paid; explorer links. No slides, no long intro.
- `docs/x-post.md`: first line = the user problem; says "built at NEAR HACKATHON"; tags `@NEARProtocol` and `#NEARHackathon` (optional `@NearBuilders`, `@NearLegion`); links repo and dashboard; says concretely what NEAR enables. **Nobody posts without the team agreeing.**

## Day-by-day (end-of-day check in brackets)

- **Sun 9 Nov:** read the docs; repo skeleton (root `package.json` with npm workspaces, `.gitignore` incl. `.env`, LICENSE); web scaffold; simulation running with stubbed pricing. *[`npm run sim` prints prices]*
- **Mon 10 Nov:** sim complete with all four findings; dashboard pages on mock data. *[Sim findings checked; Agents and Jobs pages render mock data]*
- **Tue 11 Nov:** switch to live testnet data; job detail with judge votes and receipts. *[Dashboard shows a real settled job. FEATURE FREEZE]*
- **Wed 12 Nov:** Try-it panel on Dev 2's API; deploy; README complete; GIF; demo script and X post drafts. *[A teammate follows the README cold and it works]*
- **Thu 13 Nov:** record the video; team clean-machine test; final README fixes.
- **Fri 14 Nov:** spare.

If you fall behind, drop in this order: wallet connect → price-over-time lines (use
current price only) → hosted deploy (local + video is allowed). Never drop: Job
detail with votes and receipts, Simulation page, README.

## Rules

- Testnet only. No real funds.
- Never commit keys or `.env`. The dashboard holds **no private keys**; all signing for Try-it happens in Dev 2's API.
- Work on branch `dev3/...`; merge to `main` by pull request. Don't push, make the repo public or post on X without asking me.
- Ask me before installing anything globally.

## How to start

1. Read the sources above.
2. Reply with: (a) anything unclear or risky in SPEC/MECHANISM, (b) the root workspace layout you'll create, (c) the npm packages and versions you plan to use, confirmed from the docs, (d) a one-paragraph plan for the simulation's agent and backer behaviour.
3. **Wait for my OK**, then create the repo skeleton first so Dev 1 and Dev 2 can start in their folders.

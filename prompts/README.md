# How the team uses these prompts

Each of us gives our own AI coding agent (Claude Code or Codex) one prompt.
All three prompts point to the same two files, so the three parts fit together:

- [`docs/SPEC.md`](../docs/SPEC.md): names, method signatures, JSON shapes, env vars
- [`MECHANISM.md`](../MECHANISM.md): the rules and formulas

| Who | Prompt | Owns |
|---|---|---|
| Dev 1 — Blockchain | [`dev1-contracts.md`](dev1-contracts.md) | `contract/`, `token/`, `scripts/`, `deployments/` |
| Dev 2 — Backend and AI | [`dev2-backend-ai.md`](dev2-backend-ai.md) | `shared/`, `judge/`, `agents/`, `receipts/` |
| Dev 3 — Frontend and story | [`dev3-frontend-story.md`](dev3-frontend-story.md) | `web/`, `sim/`, `README.md`, demo video, X post |

## Today (Sun 9 Nov), in this order

1. **Everyone (30 min):** read SPEC.md and MECHANISM.md together. Change anything you disagree with now. After today, changes need all three to agree.
2. **Dev 3:** create the GitHub repo (private for now), push this folder, and add the other two as collaborators. Then create the workspace skeleton.
3. **Dev 1 + Dev 2 (1 hour):** write `shared/test-vectors.json` together.
4. Everyone pastes their prompt into their agent and approves its plan before it writes code.

## Hand-offs (when one person unblocks another)

| When | From → To | What |
|---|---|---|
| Sun night | Dev 2 → all | `shared/types.ts` merged |
| Mon night | Dev 1 → Dev 2, Dev 3 | Contract deployed on testnet, ids in `deployments/testnet.json` |
| Mon night | Dev 2 → Dev 3 | `shared/pricing.ts` merged (sim switches from stub) |
| Tue night | Dev 1 + Dev 2 | A full job settles on testnet → **feature freeze** |
| Wed midday | Dev 2 → Dev 3 | Demo HTTP API running for the Try-it button |
| Thu | all | Clean-machine test, video, repo public, X post, submit |

## Daily 15-minute check-in

1. What works end to end right now?
2. What is blocking you, and who can unblock it?
3. What do we cut? (Each prompt has its own cut list.)

## Submission day (Thu 13 Nov)

Follow section 12 of the blueprint doc. One person submits, once. The **Website
field stays empty**.

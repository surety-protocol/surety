# scripts/

Testnet setup, deploy, smoke test and demo. **Owner:** Dev 1. Testnet only: every
script refuses to run unless `NEAR_NETWORK=testnet`, `NEAR_PARENT` ends in
`.testnet` and `NEAR_RPC_URL` is not a mainnet endpoint.

Run everything from the repo root after `npm install`:

| Command | What it does |
|---|---|
| `npm run setup:testnet` | Creates the 12 sub-accounts of SPEC §3 under `NEAR_PARENT`, adds the restricted keys (judge: `submit_verdict`, `settle`; agents: `register_agent`, `accept_job`, `deliver`), writes keys to `.env` and public ids to `deployments/testnet.json` |
| `npm run deploy` | Builds with `npm run contract:build`, tops up `core` and `tusdc` for their code storage, deploys, calls `new` on both (core with the default config), registers every account on the token and mints demo tUSDC |
| `npm run testnet:smoke` | One job end to end with a fixed score and no AI. Proves the deployment. `DEMO_CHECKS=2/10` for a fail. Stop the judge service first |
| `npm run judge-demo` | The real demo: sloppy, honest and cheater scenarios through the judge service (tests + 3 NEAR AI judges), printed step by step with explorer links. Starts the judge itself unless one is already running. Needs `NEARAI_API_KEY` |

All four are safe to re-run: existing accounts, keys, code and balances are kept.

## First run

1. `cp .env.example .env`, then fill in `NEAR_PARENT`, `NEAR_PARENT_PRIVATE_KEY`
   and `NEAR_RPC_URL` (a testnet endpoint from
   <https://docs.near.org/api/rpc/providers>).
2. The parent needs about 20 testnet NEAR: 0.5 per sub-account (2 for the
   judge) plus code storage for core (~5 NEAR) and the token (~3 NEAR), at
   1 NEAR per 100 kB.
3. `npm run setup:testnet && npm run deploy && npm run testnet:smoke`
4. Commit `deployments/testnet.json` (public ids only). **Never commit `.env`.**

## Keys in `.env`

Names follow SPEC §8, so the judge service and agents read them directly.

- `JUDGE_PRIVATE_KEY` is the judge's **restricted** key. The judge account's
  full key is kept as `JUDGE_FULL_PRIVATE_KEY`.
- Agents use their full keys (`HONEST_AGENT_PRIVATE_KEY`, …) in the demo,
  because bonding goes through `ft_transfer_call`, which needs a 1 yoctoNEAR
  deposit that restricted keys cannot attach. Their restricted keys
  (`*_AGENT_FC_PRIVATE_KEY`) show that an agent key cannot withdraw.
- `CORE_PRIVATE_KEY` and `TOKEN_PRIVATE_KEY` are only used by `deploy`.

Originally written by Osuochasam in surety-protocol/surety-contract#2, ported
to near-api-js 7 (the version `shared/` uses) and to the SPEC §8 key names.

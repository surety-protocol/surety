# sim/

Simulation of the Surety market (MECHANISM.md section 7). **Owner:** Dev 3.

```bash
npm run sim
```

Every job is posted, accepted, judged and settled on `MockChain` from
`@surety/shared`, the in-memory copy of the contract rules, so no formula is
re-implemented here. Fixed seed, no network, no AI calls.

Populations: 19 honest agents (true failure 2%..60%), one cheater (30%) with 3
sock-puppet clients, one colluding agent + client pair, 60 clients picking the
cheapest agent with enough coverage, 10 backers moving money each round.

Output: `sim/out/results.csv`, `agents.json`, `rounds.json`, `summary.json`.
`summary.json` and `rounds.json` are also copied to `web/public/sim/`.
Findings are reported as they come out, including ones that do not hold.

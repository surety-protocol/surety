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

## Robustness across seeds

```bash
npm run sim:seeds          # 50 seeds x 4 rule variants, writes sim/out/seeds.json
```

A single seed is mostly luck: on one run finding 1 failed and finding 2 held,
and one small modelling change swapped them. So we report how often each
finding holds over seeds 1-50, under the current rules and two experiments
(opt-in MockChain switches, off by default, not in the contract):

- **A:** an agent without backers pays its premium to a protocol reserve
  instead of its own bond, so self-dealt jobs cost money.
- **B:** repeat clients count value/k^2 instead of value/k.

| Finding | Current | A | B | A+B |
|---|---|---|---|---|
| 1. Failure rate moves toward true rate | 18/50 | 21/50 | 27/50 | 17/50 |
| 2. Agents above 40% drop out | 42/50 | 41/50 | 45/50 | 41/50 |
| 3. Cheater priced no cheaper than peers | 12/50 | 13/50 | 16/50 | 21/50 |
| 4. Collusion loses money | 50/50 | 50/50 | 50/50 | 50/50 |

What we learned:

- **Finding 1's test is too strict for agents near 20%.** Every agent starts at
  the 20% prior; for an agent whose true rate is 15-21%, "ends closer to the
  truth than the prior" fails on ordinary noise. Clients picking the cheapest
  agent also favour agents on a lucky streak. Measurements are correct
  (checked by hand: one agent with true 18% really failed 10 of 95 jobs).
- **Finding 2 mostly holds.** In failing runs, the >40% agents keep their bond
  because almost nobody hires them; they win the odd job when cheaper agents
  are full.
- **Finding 3: sock-puppet self-dealing pays, and A and B do not stop it.**
  Comparing the cheater with and without its 3 sock puppets over 50 seeds,
  cheating paid off in 34/50 runs (median +491 tUSDC, about 18 extra market
  jobs won thanks to a lower price). With A: 35/50, median +405 tUSDC. As
  written, finding 3 can hold only about half the time even without cheating,
  because the cheater has the same true skill as its peers. A real fix needs
  sybil resistance, for example weighting each client by its spending with
  other agents. That is a design change for after the hackathon.
- **Finding 4 holds in every run.**

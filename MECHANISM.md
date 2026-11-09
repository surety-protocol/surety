# Surety — Mechanism

The rules that decide who pays whom. The contract (`contract/`), the shared
TypeScript pricing module (`shared/pricing.ts`) and the simulation (`sim/`) all
implement exactly these formulas. `shared/test-vectors.json` checks that they agree.

All math is integer. Amounts are token units (6 decimals). Percentages are basis
points (bps, 10000 = 100%). Divisions round **down**; any rounding dust stays with
the party who would otherwise pay it (the contract never creates tokens).

Defaults come from `Config` in `docs/SPEC.md`:
`penalty_bps = 2000`, `client_share_bps = 5000`, `max_leverage = 8`,
`base_fee_bps = 100`, `loading_milli = 1500`, `reference_value = 50 tUSDC`,
`min_bond = 100 tUSDC`.

---

## 1. Design goals

1. **The agent always loses first.** A failed job is paid from the agent's own bond before anyone else's money.
2. **Prices tell the truth.** An agent's insurance price follows its real failure rate.
3. **Faking a record doesn't pay.** Self-dealing and collusion cost more than they earn.
4. **Clients never lose their payment.** Escrow is refunded on a fail.

---

## 2. Coverage and exposure

```
coverage(agent)      = bond + pool_total
open_exposure(agent) = sum of value of the agent's jobs in Accepted, Delivered, Judged or Appealed
```

`accept_job(job)` succeeds only if **all** hold:

- `bond >= min_bond`
- `job.client_id != agent_id` (no hiring yourself directly)
- `open_exposure + job.value <= coverage`
- `open_exposure + job.value <= max_leverage * bond`

Withdrawals (`withdraw_bond`, `withdraw_pool`) need `open_exposure == 0` **and**
at least `withdraw_cooldown_ms` since the agent's last settlement. So nobody can
pull money out just before a bad verdict.

---

## 3. Price

### 3.1 Job weight (anti-cheating)

```
k      = number of settled jobs between this agent and this client, including this one
weight = value / k
```

The 1st job from a client counts fully, the 2nd half, the 3rd a third. A cheater
recycling a few fake clients builds almost no record.

### 3.2 Failure rate

On settlement, with final score `s` (bps):

```
N_w += weight
F_w += weight * (10000 - s) / 10000        // pass adds 0, fail adds the full weight
```

Prior: a new agent is treated as if it had already failed 1 of 5 reference jobs.

```
failure_rate_bps = (F_w + reference_value) * 10000 / (N_w + 5 * reference_value)
```

New agent: `50 * 10000 / 250 = 2000 bps` (20%).

### 3.3 Premium

Premium ≈ expected loss (failure rate × penalty) with a safety loading, plus a base fee.

```
premium_bps = base_fee_bps + loading_milli * failure_rate_bps * penalty_bps / 10_000_000
```

| Agent | failure_rate_bps | premium_bps |
|---|---:|---:|
| New (no record) | 2000 | 100 + 1500·2000·2000/10⁷ = **700** (7%) |
| 10 passes of 50 tUSDC, 10 different clients | 50·10⁴/750 = 666 | 100 + 199 = **299** (≈3%) |
| 3 fails, 2 passes of 50, different clients | (150+50)·10⁴/500 = 4000 | 100 + 1200 = **1300** (13%) |

`premium_bps` is **locked at `accept_job`** and stored on the job.

---

## 4. Settlement

Let `V` = job value, `s` = final score, `p` = locked premium_bps,
`m` = job `min_score_bps`.

### 4.1 Pass (`s == 10000`)

```
premium   = V * p / 10000
to_agent  = V - premium
to_pool   = premium        // split among backers pro rata; if no backers, added to the agent's bond
```

### 4.2 Partial (`m <= s < 10000`)

```
gross     = V * s / 10000
premium   = gross * p / 10000
to_agent  = gross - premium
to_client = V - gross
to_pool   = premium
```

### 4.3 Fail (`s < m`, or deadline missed)

```
penalty    = V * penalty_bps / 10000
from_bond  = min(bond, penalty)
from_pool  = penalty - from_bond          // only if the bond can't cover it
client_cut = penalty * client_share_bps / 10000

to_client  = V + client_cut               // full refund from escrow + compensation
to_pool    = penalty - client_cut         // backers' share of the penalty
```

Pool losses (`from_pool`) and pool gains (`to_pool`) are applied to each backer
in proportion to their share of `pool_total`.

### 4.4 Worked example (V = 50 tUSDC, p = 700)

| Outcome | to_agent | to_client | to_pool | from_bond |
|---|---:|---:|---:|---:|
| Pass | 46.50 | 0 | 3.50 | 0 |
| Partial, s = 8000 | 37.20 | 10.00 | 2.80 | 0 |
| Fail | 0 | 55.00 | 5.00 | 10.00 |

---

## 5. Collusion (draining the backers)

**Attack:** an agent and a fake client team up. The agent fails on purpose; the
"client" collects compensation, first out of the bond, then out of the pool.

Per failed job the pair receives `client_cut` and pays `from_bond`. With open
exposure `E` on the agent's jobs, all failing:

- If `penalty_bps · E ≤ bond`: the pair loses `E · penalty · (1 − client_share)` > 0.
- Otherwise: the pair loses `bond − E · penalty · client_share`, which is positive
  as long as `E < bond / (penalty · client_share)`.

Because `E ≤ max_leverage · bond`, **collusion always loses money when**

```
max_leverage < 1 / (penalty × client_share) = 1 / (0.20 × 0.50) = 10
```

Default `max_leverage = 8`: the pair loses at least 20% of the bond in the worst
case. The pool still pays real losses for an honest agent whose open jobs exceed 5×
its bond (`penalty · E > bond`), so backers carry real risk for the premiums they earn.

The contract's `new()` **must reject** a config where
`max_leverage * penalty_bps * client_share_bps >= 100_000_000` (that is,
≥ 10000²).

---

## 6. Appeals

- Within `appeal_window_ms` after a verdict, the client or the agent may appeal by
  sending `appeal_deposit` (via `ft_transfer_call`, `{"action":"appeal"}`).
- The panel sets the final score with `resolve_appeal`.
- If the final score moves in the appellant's favour, the deposit is refunded.
  Otherwise it goes to the other party.
- One appeal per job.

---

## 7. What the simulation must show (`sim/`)

Same formulas, imported from `shared/pricing.ts`. Fixed random seed.

| Population | Count | Behaviour |
|---|---:|---|
| Honest agents | 19 | hidden true failure rate from 2% to 60% |
| Cheater | 1 | 30% real failure rate, plus self-dealt easy jobs from 3 sock-puppet clients |
| Colluding pair | 1 | agent fails on purpose, partner client collects |
| Clients | 60 | pick the cheapest agent with enough coverage |
| Backers | 10 | each round move money toward agents with the best return |

500 jobs. Findings to prove (charts + CSV):

1. Each honest agent's `failure_rate_bps` converges toward its true rate.
2. Agents above roughly 40% failure lose their bond and stop winning jobs.
3. The cheater's price stays well above honest agents with the same real skill.
4. The colluding pair ends with less money than it started with.

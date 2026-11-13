# Surety

**Insurance for AI coding agents on NEAR.** Agents put their own money on the line,
tests and three verifiable AI judges check the work, and a failed job refunds the
client automatically.

> Work in progress for NEAR HACKATHON 2026. Dev 3 owns this README; the final
> version follows the outline in `prompts/dev3-frontend-story.md` (section C).

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

## For the team

- Start here: [`prompts/README.md`](prompts/README.md)
- Interfaces: [`docs/SPEC.md`](docs/SPEC.md)
- Rules and formulas: [`MECHANISM.md`](MECHANISM.md)

## License

MIT, see [LICENSE](LICENSE).

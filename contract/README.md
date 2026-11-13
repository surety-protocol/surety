# contract/

Surety core contract (Rust, near-sdk 5.30). **Owner:** Dev 1.

Implements docs/SPEC.md section 4 and MECHANISM.md. Every rule mirrors
`shared/src/mock-chain.ts`, the in-memory reference the judge, agents,
simulation and dashboard are tested against.

| File | What |
|---|---|
| `src/lib.rs` | State, `ft_on_transfer`, change methods, views, payouts |
| `src/pricing.rs` | Pure formulas (mirror `shared/src/pricing.ts`) |
| `src/config.rs` | Config with defaults and the anti-collusion check |
| `src/agent.rs`, `src/job.rs` | Stored state and the SPEC 4.5 view shapes |
| `src/events.rs` | NEP-297 events, `data` is an array |
| `src/tests.rs` | Every case in `shared/test-vectors.json` + contract flows |

Payouts use `ft_transfer` with a callback. If a transfer fails (for example the
receiver never called `storage_deposit` on the token), the amount is added to
`claimable` and the receiver pulls it with `claim()`.

## Build and test

```bash
npm run contract:test     # cargo test --workspace (contract + token)
npm run contract:build    # wasm for both contracts in target/wasm32-unknown-unknown/release/
```

On Windows, `aws-lc-sys` needs cmake on PATH (it ships with Visual Studio Build
Tools, see `.cargo/config.toml`).

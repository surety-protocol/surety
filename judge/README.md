# judge/

The judge service: it checks delivered work and tells the Surety contract the result.

**Owner:** Dev 2. Interfaces: `docs/SPEC.md` §5–§7. Rules: `MECHANISM.md`.

## What it does, per delivered job

1. Loads the job spec and the patch and checks both SHA-256 hashes against the chain. A mismatch scores 0.
2. Copies the job's repo to a temp folder, applies the patch with `git apply` and runs the tests.
   - Only `npm test` / `npm test --silent` may run (the spec comes from the client).
   - Patched code gets **no secrets** in its environment, a 2-minute timeout and capped output.
   - Patches with symlinks, binary content or paths outside the repo are refused.
   - `JUDGE_DOCKER=1` runs the tests in a no-network container instead.
3. Asks three AI judges on NEAR AI Cloud about each AI check. For each model:
   - **Before the call:** fresh 32-byte nonce, then an attestation report verified in full: Intel TDX quote (DCAP), debug mode off, nonce and signer bound in the quote, MRCONFIGID, RTMR3 event-log replay, NVIDIA GPU evidence via NRAS.
   - **The call:** exact request and response bytes kept.
   - **After:** the response signature (`provider_tee`) must cover those exact bytes and match exactly one verified model signer.
   - A vote counts only if both checks pass. A check passes with 2 of 3 counted votes.
4. Writes `receipts/<job_id>/` (verdict, test log, one file per judge with the full attestation report, request, response and signature). `receipts_hash` = SHA-256 of `verdict.json`. Receipts are scanned so they never contain an API key or auth header.
5. Calls `submit_verdict` with the judge's function-call key, then `settle` after the appeal window.

## Commands

```bash
npm run attest -w @surety/judge          # live: fully verify all 3 judge models (no API key needed)
npm test -w @surety/judge                # 58 offline tests
npm run test:live -w @surety/judge       # live NEAR AI tests (judging part needs NEARAI_API_KEY)
npm run judge                            # start worker + demo API (reads .env)
```

Before Dev 1's contract is on testnet, run everything locally on an in-memory chain:

```bash
SURETY_CHAIN=mock JUDGE_AI_MODE=offline JUDGE_ALLOW_UNVERIFIED=1 npm run judge
curl -X POST localhost:8787/demo/run -H 'content-type: application/json' -d '{"scenario":"sloppy"}'
curl localhost:8787/demo/status/0
```

Offline mode uses rule-based stand-ins, marks every receipt UNVERIFIED, and must never be used for the real demo.

## Judge models

`deepseek-ai/DeepSeek-V4.1-Flash-1017`, `z-ai/glm-5.3-flash`, `Qwen/Qwen3.8-27B`: NEAR-operated TEE models from three different labs. Many other models on NEAR AI Cloud are passthroughs to outside providers and have no TEE evidence, so they can't be judges.

## Known limits (state these in the main README)

- The test runner and vote counting run on our server; the contract trusts the judge account for them. Next step: run the whole judge inside a TEE.
- Without Docker, patched code runs as a normal process in a temp folder (no secrets, but not a sandbox).

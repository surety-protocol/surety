// npm run attest -w @surety/judge
// Fetches a fresh attestation report for each judge model and runs the FULL
// verification (Intel DCAP quote with collateral, nonce and signer binding,
// MRCONFIGID, RTMR3 replay, NVIDIA GPU evidence via NRAS). Needs no API key.

import { randomBytes } from "node:crypto";
import { loadEnv } from "@surety/shared/env";
import { NearAiClient } from "../nearai/client.ts";
import { dcapVerifier, nrasGpuVerifier, verifyPreflight } from "../nearai/attestation.ts";
import { DEFAULT_JUDGE_MODELS, list, policyFromEnv } from "../config.ts";

loadEnv();
const client = new NearAiClient(process.env.NEARAI_BASE_URL || "https://cloud-api.near.ai/v1", process.env.NEARAI_API_KEY);
const policy = policyFromEnv();
let failed = 0;
for (const model of list(process.env.JUDGE_MODELS, DEFAULT_JUDGE_MODELS)) {
  const nonce = randomBytes(32).toString("hex");
  try {
    const bundle = await client.attestationReport(model, nonce);
    const r = await verifyPreflight(bundle, model, nonce, policy, dcapVerifier, nrasGpuVerifier());
    console.log(`\n✔ ${model}`);
    console.log(`  gateway signer ${r.gateway.signing_address} (TCB ${r.gateway.tcb_status})`);
    for (const m of r.models) {
      console.log(`  model signer   ${m.signing_address} (TCB ${m.tcb_status}, GPU ${m.gpu})`);
      for (const c of m.checks) console.log(`    - ${c}`);
    }
  } catch (e) {
    failed++;
    console.log(`\n✖ ${model}: ${(e as Error).message}`);
  }
}
process.exit(failed ? 1 : 0);

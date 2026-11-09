// Starts the judge worker and the demo HTTP API.
//   SURETY_CHAIN=near (default): the real contract on testnet, ids from .env / deployments/testnet.json
//   SURETY_CHAIN=mock: an in-memory chain with funded demo accounts, for local work before
//                      the contract is deployed. Nothing touches the network except NEAR AI.

import { join } from "node:path";
import { loadEnv, nearChainFromEnv, REPO_ROOT, requireEnv } from "@surety/shared/env";
import { MockChain } from "@surety/shared/mock-chain";
import type { SuretyChain } from "@surety/shared/chain";
import { createApi } from "./api.ts";
import { panelFromEnv, list } from "./config.ts";
import { DemoRunner, type DemoAccounts } from "./demo.ts";
import { JudgeWorker } from "./worker.ts";

loadEnv();
const mode = process.env.SURETY_CHAIN ?? "near";
const receiptsDir = join(REPO_ROOT, "receipts");

let chain: SuretyChain;
let accounts: DemoAccounts;
let judgeId: string;

if (mode === "mock") {
  const p = "surety.local";
  judgeId = `judge.${p}`;
  accounts = { client: `client.${p}`, honest: `honest-agent.${p}`, sloppy: `sloppy-agent.${p}`, cheater: `cheater-agent.${p}`, fakeClients: [1, 2, 3].map((i) => `fake-client-${i}.${p}`) };
  const m = new MockChain({ contractId: `core.${p}`, tokenId: `tusdc.${p}`, judgeId, panelId: `panel.${p}`, startMs: Date.now() });
  for (const a of [accounts.client, accounts.honest, accounts.sloppy, accounts.cheater, ...accounts.fakeClients]) m.mint(a, "1000000000000");
  setInterval(() => m.setTime(Math.max(Date.now(), (m as unknown as { clock: number }).clock)), 250).unref();
  chain = m;
  console.log("[judge] SURETY_CHAIN=mock: in-memory chain, demo accounts funded");
} else if (mode === "near") {
  chain = nearChainFromEnv();
  const parent = requireEnv("NEAR_PARENT");
  judgeId = process.env.JUDGE_ACCOUNT_ID || `judge.${parent}`;
  accounts = { client: `client.${parent}`, honest: `honest-agent.${parent}`, sloppy: `sloppy-agent.${parent}`, cheater: `cheater-agent.${parent}`, fakeClients: [1, 2, 3].map((i) => `fake-client-${i}.${parent}`) };
} else {
  throw new Error(`SURETY_CHAIN must be "near" or "mock", got ${mode}`);
}

const panel = panelFromEnv();
if (!panel.verified) console.warn("[judge] WARNING: offline AI judges. Receipts are marked UNVERIFIED. Never use this for the real demo.");

let demo: DemoRunner;
const worker = new JudgeWorker({
  chain,
  judgeId,
  repoRoot: REPO_ROOT,
  receiptsDir,
  panel,
  useDocker: process.env.JUDGE_DOCKER === "1",
  secrets: [process.env.NEARAI_API_KEY, ...Object.entries(process.env).filter(([k]) => k.endsWith("_PRIVATE_KEY")).map(([, v]) => v)],
  onStep: (jobId, step, detail) => demo?.record(jobId, step, detail),
});
demo = new DemoRunner({ chain, worker, accounts, repoRoot: REPO_ROOT });

const port = Number(process.env.DEMO_API_PORT ?? 8787);
createApi({ chain, demo, receiptsDir, corsOrigins: list(process.env.DEMO_CORS_ORIGINS, ["http://localhost:5173"]) }).listen(port, () => {
  console.log(`[judge] contract ${chain.contractId}, judges: ${panel.models.join(", ")}`);
  console.log(`[judge] demo API on http://localhost:${port}`);
});
worker.start(Number(process.env.JUDGE_POLL_MS ?? 4000));

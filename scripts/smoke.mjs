// npm run testnet:smoke
//
// Contract-only check on testnet, no AI and no tests run: one job goes
// post -> accept -> deliver -> verdict -> settle with a fixed score, signed by
// the real keys from .env (the judge uses its restricted key). Use it to prove
// the deployment works before running the full demo (npm run judge-demo).
//
// Stop the judge service first: it would try to judge this fake delivery.
//
//   DEMO_CHECKS=10/10 (default, pass) | 7/10 (partial) | 2/10 (fail)
//
// Based on Osuochasam's demo.mjs in surety-protocol/surety-contract#2.

import { createHash } from "node:crypto";
import {
  ACCOUNTS, TGAS, call, connect, deploymentFor, env, events, fail, formatTusdc,
  requireEnv, requireTestnet, txUrl,
} from "./lib/near.mjs";

const JOB_VALUE = 50_000_000n; // 50 tUSDC
const [PASSED, TOTAL] = (env("DEMO_CHECKS") ?? "10/10").split("/").map(Number);
if (!(TOTAL > 0 && PASSED >= 0 && PASSED <= TOTAL)) fail("DEMO_CHECKS must look like 7/10");
const SCORE = Math.floor((PASSED * 10_000) / TOTAL); // same rule as the contract's score_from_counts
const sha = (s) => createHash("sha256").update(s).digest("hex");

async function main() {
  const { parent, rpcUrl } = requireTestnet();
  const dep = deploymentFor(parent);
  const chain = connect(rpcUrl);
  const client = chain.account(dep.accounts.client, requireEnv(ACCOUNTS.client));
  const agent = chain.account(dep.accounts.honest_agent, requireEnv(ACCOUNTS["honest-agent"]));
  const judge = chain.account(dep.judge_id, requireEnv("JUDGE_PRIVATE_KEY", "restricted judge key from npm run setup:testnet"));
  const step = (name, r) => console.log(`  ✓ ${name}${r ? `  ${txUrl(r.tx)}` : ""}`);

  console.log(`\nSurety smoke test on ${dep.contract_id}: score ${SCORE} bps (${PASSED}/${TOTAL} checks)\n`);

  // Agent: register once, then keep the bond at min_bond.
  const cfg = await chain.view(dep.contract_id, "get_config");
  let view = await chain.view(dep.contract_id, "get_agent", { agent_id: agent.accountId });
  if (!view) {
    step("agent registered", await call(agent, dep.contract_id, "register_agent"));
    view = await chain.view(dep.contract_id, "get_agent", { agent_id: agent.accountId });
  }
  const missing = BigInt(cfg.min_bond) - BigInt(view.bond);
  if (missing > 0n) {
    const r = await call(agent, dep.token_id, "ft_transfer_call", { receiver_id: dep.contract_id, amount: missing.toString(), msg: JSON.stringify({ action: "bond" }) }, { deposit: 1n, gas: 100n * TGAS });
    step(`bond topped up by ${formatTusdc(missing)} tUSDC`, r);
  }

  // Client posts a job.
  const now = Date.now();
  const post = await call(client, dep.token_id, "ft_transfer_call", {
    receiver_id: dep.contract_id,
    amount: JOB_VALUE.toString(),
    msg: JSON.stringify({ action: "post_job", spec_hash: sha(`smoke-spec-${now}`), spec_url: "https://example.com/smoke-spec.json", deadline_ms: now + 30 * 60_000 }),
  }, { deposit: 1n, gas: 100n * TGAS });
  const jobId = events(post.logs).find((e) => e.event === "job_posted")?.data?.[0]?.job_id;
  if (jobId === undefined) fail(`job_posted event not found  ${txUrl(post.tx)}`);
  step(`job ${jobId} posted (${formatTusdc(JOB_VALUE)} tUSDC)`, post);

  step("accepted", await call(agent, dep.contract_id, "accept_job", { job_id: jobId }));
  step("delivered", await call(agent, dep.contract_id, "deliver", { job_id: jobId, patch_url: "https://example.com/smoke.patch", patch_hash: sha(`smoke-patch-${now}`) }));
  step(`verdict ${SCORE} bps`, await call(judge, dep.contract_id, "submit_verdict", {
    job_id: jobId, score_bps: SCORE, checks_passed: PASSED, checks_total: TOTAL, receipts_hash: sha(`smoke-receipts-${now}`),
  }));

  // Settle once the appeal window has closed (checked against the chain's clock).
  const job = await chain.view(dep.contract_id, "get_job", { job_id: jobId });
  process.stdout.write(`  … waiting for the appeal window (${Math.round(cfg.appeal_window_ms / 1000)} s)`);
  for (;;) {
    const block = await chain.provider.viewBlock({ finality: "final" });
    if (Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n) >= job.verdict.appeal_deadline_ms) break;
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 5_000));
  }
  console.log();
  step("settled", await call(judge, dep.contract_id, "settle", { job_id: jobId }, { gas: 200n * TGAS }));

  const done = await chain.view(dep.contract_id, "get_job", { job_id: jobId });
  const s = done.settlement;
  console.log(`\n  ${s.outcome}: agent got ${formatTusdc(s.to_agent)}, client got ${formatTusdc(s.to_client)}, pool got ${formatTusdc(s.to_pool)} tUSDC`);
  console.log(`  https://testnet.nearblocks.io/address/${dep.contract_id}\n`);
}

main().catch((e) => fail(`smoke test failed: ${e?.message ?? e}`));

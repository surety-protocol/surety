// npm run judge-demo [-- sloppy honest cheater]
//
// The full demo on testnet, the same flow as the dashboard's Try-it button:
// for each scenario a job is posted, the scripted agent accepts and delivers,
// the judge runs the tests and the three NEAR AI judges, and the contract
// settles once the appeal window closes. Every step is printed with its
// explorer link.
//
// Uses the judge service's demo API (SPEC §7). If one is already running on
// DEMO_API_PORT it is reused; otherwise this starts `npm run judge` and stops it
// at the end. Needs NEARAI_API_KEY for verified AI votes.

import { execSync, spawn } from "node:child_process";
import { ROOT, env, fail, formatTusdc, requireTestnet } from "./lib/near.mjs";

const SCENARIOS = ["sloppy", "honest", "cheater"];
const picked = process.argv.slice(2).filter((a) => SCENARIOS.includes(a));
const runList = picked.length ? picked : SCENARIOS;
const API = `http://localhost:${env("DEMO_API_PORT") ?? 8787}`;
const RUN_TIMEOUT_MS = 15 * 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Stop the judge and everything npm started under it. */
function stop(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: "ignore" });
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill();
  }
}

async function health() {
  try {
    const r = await fetch(`${API}/health`, { signal: AbortSignal.timeout(3_000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function startJudge() {
  console.log("Starting the judge service (npm run judge)…");
  const child = spawn("npm", ["run", "judge"], { cwd: ROOT, shell: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  const prefix = (chunk) => chunk.toString().split(/\r?\n/).filter(Boolean).forEach((l) => console.log(`    [judge] ${l}`));
  child.stdout.on("data", prefix);
  child.stderr.on("data", prefix);
  child.on("exit", (code) => code && code !== 0 && console.error(`    [judge] exited with code ${code}`));
  for (let i = 0; i < 60; i++) {
    if (await health()) return child;
    if (child.exitCode !== null) fail("the judge service stopped before it was ready (see its output above).");
    await sleep(1_000);
  }
  stop(child);
  fail(`the judge service did not answer on ${API}/health within 60 s.`);
}

async function runScenario(kind) {
  console.log(`\n── ${kind} ──────────────────────────────`);
  let jobId;
  for (;;) {
    const r = await fetch(`${API}/demo/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenario: kind }) });
    const body = await r.json();
    if (r.status === 202) {
      jobId = body.job_id;
      break;
    }
    if (r.status === 429 && /in progress/.test(body.error ?? "")) {
      await sleep(5_000);
      continue;
    }
    throw new Error(`POST /demo/run (${kind}): ${r.status} ${body.error ?? ""}`);
  }

  let shown = 0;
  const end = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < end) {
    const s = await (await fetch(`${API}/demo/status/${jobId}`)).json();
    for (const st of (s.steps ?? []).slice(shown)) {
      const mark = st.status === "failed" ? "✗" : "✓";
      console.log(`  ${mark} ${st.name}${st.detail ? `: ${st.detail}` : ""}${st.tx_url ? `\n      ${st.tx_url}` : ""}`);
    }
    shown = s.steps?.length ?? shown;
    if (s.steps?.some((st) => st.status === "failed")) return { kind, jobId, ok: false };
    const job = s.job;
    if (job?.status === "Settled" || job?.status === "Cancelled") {
      const v = job.verdict;
      const st = job.settlement;
      const score = v ? `${v.checks_passed}/${v.checks_total} checks` : "no verdict";
      const money = st ? `agent ${formatTusdc(st.to_agent)}, client ${formatTusdc(st.to_client)}, pool ${formatTusdc(st.to_pool)} tUSDC` : "";
      console.log(`  → job ${jobId}: ${score}, ${st?.outcome ?? job.status}. ${money}`);
      return { kind, jobId, ok: true };
    }
    await sleep(3_000);
  }
  console.log(`  ✗ job ${jobId} did not settle within ${RUN_TIMEOUT_MS / 60_000} min`);
  return { kind, jobId, ok: false };
}

async function main() {
  requireTestnet();
  if ((env("SURETY_CHAIN") ?? "near") !== "near") fail("SURETY_CHAIN must be near for the testnet demo.");
  if ((env("JUDGE_AI_MODE") ?? "nearai") === "nearai" && !env("NEARAI_API_KEY")) {
    fail("NEARAI_API_KEY is missing. The AI judges need it (or set JUDGE_AI_MODE=offline for an unverified dry run).");
  }

  let child = null;
  const h = await health();
  if (h) console.log(`Using the judge service already running on ${API} (contract ${h.contract_id})`);
  else child = await startJudge();

  const results = [];
  try {
    for (const kind of runList) results.push(await runScenario(kind));
  } finally {
    stop(child);
  }

  console.log("\nSummary");
  for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.kind}: job ${r.jobId}`);
  console.log(`Receipts: receipts/<job_id>/ · Contract: https://testnet.nearblocks.io/address/${env("SURETY_CONTRACT_ID") ?? ""}\n`);
  if (results.some((r) => !r.ok)) process.exit(1);
}

main().catch((e) => fail(`demo failed: ${e?.message ?? e}`));

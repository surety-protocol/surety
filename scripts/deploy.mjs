// npm run deploy [-- --skip-build]
//
// Builds and deploys the token and the Surety contract to the accounts made by
// setup-testnet.mjs, then funds the demo accounts. Safe to re-run: code is only
// redeployed when it changed, init only runs once, mints only top balances up.
//
//   1. npm run contract:build (same build CI uses, wasm with target-cpu=mvp)
//   2. Tops up core and tusdc so they can pay for their code storage
//      (1 NEAR per 100 kB), then deploys both
//   3. tusdc.new(owner_id = tusdc), core.new(token, judge, panel, config = null -> defaults)
//   4. Registers every account on the token (storage_deposit)
//   5. Mints demo tUSDC: client and backer 10,000; agents and fake clients 1,000
//   6. Updates deployments/testnet.json
//
// Based on Osuochasam's script in surety-protocol/surety-contract#2.

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { baseEncode } from "near-api-js";
import {
  ACCOUNTS, AGENTS, NEAR, ROOT, STORAGE_PRICE_PER_BYTE, TGAS, call, connect, deploymentFor, fail,
  formatNear, formatTusdc, requireEnv, requireTestnet, txUrl, writeDeployments,
} from "./lib/near.mjs";

const SKIP_BUILD = process.argv.includes("--skip-build");
const WASM_DIR = join(ROOT, "target", "wasm32-unknown-unknown", "release");
const TOKEN_WASM = join(WASM_DIR, "tusdc_token.wasm");
const CORE_WASM = join(WASM_DIR, "surety_core.wasm");
/** NEAR kept on top of code storage, for contract state and gas. */
const STATE_MARGIN = 1n * NEAR;

const TUSDC = 1_000_000n; // 6 decimals
const MINT = { client: 10_000n * TUSDC, backer: 10_000n * TUSDC, agent: 1_000n * TUSDC, fakeClient: 1_000n * TUSDC };

async function main() {
  const { parent: parentId, rpcUrl } = requireTestnet();
  const dep = deploymentFor(parentId);
  const chain = connect(rpcUrl);
  const parent = chain.account(parentId, requireEnv("NEAR_PARENT_PRIVATE_KEY"));
  const token = chain.account(dep.token_id, requireEnv(ACCOUNTS.tusdc, "run npm run setup:testnet first"));
  const core = chain.account(dep.contract_id, requireEnv(ACCOUNTS.core, "run npm run setup:testnet first"));

  if (execSync("git ls-files .env", { cwd: ROOT }).toString().trim()) fail(".env is tracked by git. Remove it from the index before deploying.");

  console.log(`\nSurety deploy\n  parent: ${parentId}\n  core:   ${dep.contract_id}\n  token:  ${dep.token_id}\n`);

  // 1. Build
  if (SKIP_BUILD) console.log("1. Build skipped (--skip-build)");
  else {
    console.log("1. Building (npm run contract:build)");
    execSync("npm run contract:build", { cwd: ROOT, stdio: "inherit" });
  }
  for (const f of [TOKEN_WASM, CORE_WASM]) if (!existsSync(f)) fail(`${f} not found. Run without --skip-build.`);

  // 2. Fund + deploy code
  console.log("\n2. Deploying code");
  for (const [acct, file] of [[token, TOKEN_WASM], [core, CORE_WASM]]) {
    const code = readFileSync(file);
    const need = BigInt(code.length) * STORAGE_PRICE_PER_BYTE + STATE_MARGIN;
    const state = await acct.getState();
    if (state.balance.total < need) {
      const top = need - state.balance.total;
      await parent.transfer({ receiverId: acct.accountId, amount: top });
      console.log(`  + sent ${formatNear(top)} NEAR to ${acct.accountId} for ${(code.length / 1000).toFixed(0)} kB of code`);
    }
    const hash = baseEncode(createHash("sha256").update(code).digest());
    if (state.codeHash === hash) {
      console.log(`  ✓ ${acct.accountId} already runs this code`);
      continue;
    }
    const r = await acct.deployContract(new Uint8Array(code));
    console.log(`  + deployed ${file.split(/[\\/]/).pop()} to ${acct.accountId}  ${txUrl(r.transaction.hash)}`);
  }

  // 3. Init
  console.log("\n3. Init");
  if (await chain.view(dep.token_id, "ft_metadata").then(() => true, () => false)) console.log(`  ✓ ${dep.token_id} already initialised`);
  else {
    const r = await call(token, dep.token_id, "new", { owner_id: dep.token_id });
    console.log(`  + ${dep.token_id}.new(owner_id = ${dep.token_id})  ${txUrl(r.tx)}`);
  }
  if (await chain.view(dep.contract_id, "get_config").then(() => true, () => false)) console.log(`  ✓ ${dep.contract_id} already initialised`);
  else {
    const r = await call(core, dep.contract_id, "new", { token_id: dep.token_id, judge_id: dep.judge_id, panel_id: dep.panel_id, config: null });
    console.log(`  + ${dep.contract_id}.new(token, judge, panel, default config)  ${txUrl(r.tx)}`);
  }

  // 4. Token storage for every account (core must be registered to receive ft_transfer_call)
  console.log("\n4. Token storage");
  const everyone = [parentId, ...Object.values(dep.accounts)];
  const bounds = await chain.view(dep.token_id, "storage_balance_bounds");
  let registered = 0;
  for (const id of everyone) {
    if (await chain.view(dep.token_id, "storage_balance_of", { account_id: id })) continue;
    await call(token, dep.token_id, "storage_deposit", { account_id: id, registration_only: true }, { deposit: BigInt(bounds.min) });
    registered++;
  }
  console.log(`  ✓ ${everyone.length} accounts registered (${registered} new)`);

  // 5. Demo balances (mint takes no deposit; only tops up to the target)
  console.log("\n5. Demo tUSDC");
  const targets = [
    [dep.accounts.client, MINT.client],
    [dep.accounts.backer, MINT.backer],
    ...AGENTS.map((a) => [`${a}.${parentId}`, MINT.agent]),
    ...[1, 2, 3].map((i) => [`fake-client-${i}.${parentId}`, MINT.fakeClient]),
  ];
  for (const [id, target] of targets) {
    const have = BigInt(await chain.view(dep.token_id, "ft_balance_of", { account_id: id }));
    if (have >= target) {
      console.log(`  ✓ ${id}: ${formatTusdc(have)} tUSDC`);
      continue;
    }
    await call(token, dep.token_id, "mint", { account_id: id, amount: (target - have).toString() }, { gas: 30n * TGAS });
    console.log(`  + ${id}: minted ${formatTusdc(target - have)} tUSDC`);
  }

  // 6. Public record
  writeDeployments({ ...dep, deployed_at: new Date().toISOString() });
  console.log("\n6. Updated deployments/testnet.json");

  console.log(`\nLive on testnet: https://testnet.nearblocks.io/address/${dep.contract_id}`);
  console.log("Next: npm run testnet:smoke (contract only, no AI) or npm run judge-demo (full demo with the judge)\n");
}

main().catch((e) => fail(`deploy failed: ${e?.message ?? e}`));

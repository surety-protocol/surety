/**
 * scripts/deploy.mjs
 *
 * Builds and deploys the Surety contracts to NEAR testnet.
 *
 * What it does
 * ────────────
 * 1. Builds token/ and contract/ via `cargo near build --no-abi`
 * 2. Deploys tusdc WASM to tusdc.<parent>
 * 3. Deploys surety-core WASM to core.<parent>
 * 4. Calls new(token_id, judge_id, panel_id, null) on core.<parent>
 *    (uses default Config from the contract — SPEC §4.1 defaults)
 * 5. Mints initial tUSDC demo balances to all participant accounts
 * 6. Registers storage deposits for all participants on the token contract
 * 7. Updates deployments/testnet.json with wasm hashes and deployed_at timestamp
 *
 * Usage
 * ─────
 *   node scripts/deploy.mjs
 *
 * Flags
 * ─────
 *   --reset-state   Pass a migrate/reset init call if the contract needs fresh state.
 *                   Default: skip init if contract is already initialised.
 *   --skip-build    Skip the cargo build step (use existing WASM files).
 */

import 'dotenv/config';
import { execSync }  from 'child_process';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  nearConnect, loadKey, getAccount,
  registerStorageDeposit, mintTokens, upsertEnv,
  readDeployments, writeDeployments, accountIdToEnvKey,
  DEPLOYMENTS_DIR, DEFAULT_GAS, ONE_NEAR,
  keyStore, NETWORK_ID,
} from './lib/near.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');

// ── CLI flags ─────────────────────────────────────────────────────────────────

const RESET_STATE  = process.argv.includes('--reset-state');
const SKIP_BUILD   = process.argv.includes('--skip-build');

// ── WASM output locations (cargo near build writes here) ─────────────────────

const TOKEN_WASM_PATH    = join(ROOT, 'target', 'near', 'tusdc_token.wasm');
const CONTRACT_WASM_PATH = join(ROOT, 'target', 'near', 'surety_core.wasm');

// ── Demo mint amounts ─────────────────────────────────────────────────────────

/** 10,000 tUSDC per participant (6 decimal places → 10_000 * 1_000_000) */
const DEMO_MINT_AMOUNT = '10000000000';

// ── Validate environment ──────────────────────────────────────────────────────

const PARENT     = process.env.NEAR_PARENT?.trim();
const PARENT_KEY = process.env.NEAR_PARENT_PRIVATE_KEY?.trim();

if (!PARENT || !PARENT_KEY) {
  console.error('❌  Missing NEAR_PARENT or NEAR_PARENT_PRIVATE_KEY in .env');
  console.error('    Run scripts/setup-testnet.mjs first.');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Load a named account from .env keys, falling back to envUpdates for
 * keys written during the same session.
 */
function loadAccountKey(near, accountId) {
  const envKey = accountIdToEnvKey(accountId) + '_PRIVATE_KEY';
  const privKey = process.env[envKey];
  if (!privKey) throw new Error(`No private key in .env for ${accountId}  (looked for ${envKey})`);
  loadKey(accountId, privKey);
  return near.account(accountId);
}

/**
 * Run a shell command synchronously, streaming stdout/stderr to the console.
 */
function run(cmd, cwd = ROOT) {
  console.log(`\n  $ ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit', shell: true });
}

/**
 * Read a deployed WASM file and return its contents as a Buffer.
 */
function readWasm(wasmPath) {
  if (!existsSync(wasmPath)) {
    throw new Error(`WASM not found at ${wasmPath}. Run without --skip-build to compile.`);
  }
  return readFileSync(wasmPath);
}

/**
 * Check whether a NEAR contract is already initialised by calling a
 * read-only view method.  Returns true if the call succeeds.
 */
async function isInitialised(account, contractId) {
  try {
    await account.viewFunction({ contractId, methodName: 'get_config', args: {} });
    return true;
  } catch {
    return false;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   Surety — Contract Deploy                   ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  console.log(`Parent : ${PARENT}`);
  console.log(`Reset  : ${RESET_STATE}`);
  console.log(`Build  : ${!SKIP_BUILD}\n`);

  // ── Step 1: Build contracts ───────────────────────────────────────────────
  if (!SKIP_BUILD) {
    console.log('── Step 1: Building contracts ───────────────────────────────────');
    console.log('  Building token/ …');
    run('cargo near build --no-abi', join(ROOT, 'token'));
    console.log('\n  Building contract/ …');
    run('cargo near build --no-abi', join(ROOT, 'contract'));
    console.log('\n  ✅  Build complete\n');
  } else {
    console.log('── Step 1: Skipping build (--skip-build flag)\n');
    if (!existsSync(TOKEN_WASM_PATH) || !existsSync(CONTRACT_WASM_PATH)) {
      throw new Error('WASM files not found — remove --skip-build to compile first.');
    }
  }

  // ── Load WASM ─────────────────────────────────────────────────────────────
  const tokenWasm    = readWasm(TOKEN_WASM_PATH);
  const contractWasm = readWasm(CONTRACT_WASM_PATH);
  console.log(`  Token WASM     : ${tokenWasm.byteLength.toLocaleString()} bytes`);
  console.log(`  Contract WASM  : ${contractWasm.byteLength.toLocaleString()} bytes\n`);

  // ── Load parent and all needed accounts ───────────────────────────────────
  loadKey(PARENT, PARENT_KEY);
  const near   = await nearConnect();
  const parent = await near.account(PARENT);

  const tusdcId  = `tusdc.${PARENT}`;
  const coreId   = `core.${PARENT}`;
  const judgeId  = `judge.${PARENT}`;
  const panelId  = `panel.${PARENT}`;
  const clientId = `client.${PARENT}`;
  const backerId = `backer.${PARENT}`;

  const agentIds = [
    `honest-agent.${PARENT}`,
    `sloppy-agent.${PARENT}`,
    `cheater-agent.${PARENT}`,
  ];
  const fakeClientIds = [
    `fake-client-1.${PARENT}`,
    `fake-client-2.${PARENT}`,
    `fake-client-3.${PARENT}`,
  ];

  const tusdcAccount = await loadAccountKey(near, tusdcId);
  const coreAccount  = await loadAccountKey(near, coreId);

  // ── Step 2: Deploy tusdc token ────────────────────────────────────────────
  console.log('── Step 2: Deploying tusdc token ────────────────────────────────');
  await tusdcAccount.deployContract(tokenWasm);
  console.log(`  ✅  Deployed tusdc token to ${tusdcId}\n`);

  // Initialise token contract (owner = tusdcId itself so it can mint).
  // The init is idempotent — if already initialised we skip.
  let tusdcInitialised = false;
  try {
    await tusdcAccount.viewFunction({
      contractId: tusdcId,
      methodName: 'ft_metadata',
      args: {},
    });
    tusdcInitialised = true;
    console.log('  ✓  tusdc already initialised — skipping init\n');
  } catch {
    tusdcInitialised = false;
  }

  if (!tusdcInitialised) {
    await tusdcAccount.functionCall({
      contractId:      tusdcId,
      methodName:      'new',
      args:             { owner_id: tusdcId },
      gas:              DEFAULT_GAS,
      attachedDeposit:  0n,
    });
    console.log('  ✅  tusdc initialised (owner = tusdc account)\n');
  }

  // ── Step 3: Deploy surety-core contract ───────────────────────────────────
  console.log('── Step 3: Deploying surety-core contract ───────────────────────');
  await coreAccount.deployContract(contractWasm);
  console.log(`  ✅  Deployed surety-core to ${coreId}\n`);

  // ── Step 4: Initialise surety-core ────────────────────────────────────────
  console.log('── Step 4: Initialising surety-core ─────────────────────────────');

  if (!RESET_STATE && await isInitialised(coreAccount, coreId)) {
    console.log('  ✓  surety-core already initialised — skipping\n');
    console.log('     Tip: use --reset-state flag to force re-initialisation.\n');
  } else {
    /**
     * new(token_id, judge_id, panel_id, config)
     *   config = null  →  use the default Config::new_with_panel(panel_id)
     *
     * SPEC §4.1 defaults (embedded in the contract):
     *   min_bond:               100_000_000  (100 tUSDC)
     *   reference_value:         50_000_000  (50 tUSDC)
     *   penalty_bps:               2000      (20%)
     *   client_share_bps:          5000      (50%)
     *   max_leverage:                 8
     *   base_fee_bps:               100      (1%)
     *   loading_milli:             1500      (1.5×)
     *   default_min_score_bps:     5000
     *   appeal_window_ms:        120_000      (2 min)
     *   appeal_deposit:           5_000_000  (5 tUSDC)
     *   withdraw_cooldown_ms:     60_000      (1 min)
     *   max_backers_per_agent:        20
     */
    await coreAccount.functionCall({
      contractId:      coreId,
      methodName:      'new',
      args:             {
        token_id:  tusdcId,
        judge_id:  judgeId,
        panel_id:  panelId,
        config:    null,          // use contract defaults
      },
      gas:              DEFAULT_GAS,
      attachedDeposit:  0n,
    });
    console.log('  ✅  surety-core initialised\n');
    console.log(`     token_id  : ${tusdcId}`);
    console.log(`     judge_id  : ${judgeId}`);
    console.log(`     panel_id  : ${panelId}\n`);
  }

  // ── Step 5: Register storage deposits ────────────────────────────────────
  console.log('── Step 5: Registering storage deposits on tusdc ────────────────');

  const allParticipants = [
    PARENT,
    tusdcId,
    coreId,
    judgeId,
    panelId,
    clientId,
    backerId,
    ...agentIds,
    ...fakeClientIds,
  ];

  for (const accountId of allParticipants) {
    await registerStorageDeposit(tusdcAccount, tusdcId, accountId);
  }
  console.log('  ✅  Storage deposits complete\n');

  // ── Step 6: Mint demo balances ────────────────────────────────────────────
  console.log('── Step 6: Minting demo tUSDC balances ──────────────────────────');
  console.log(`  Amount per account: ${Number(DEMO_MINT_AMOUNT).toLocaleString()} units = 10,000 tUSDC\n`);

  const mintTargets = [
    clientId,
    backerId,
    ...agentIds,
    ...fakeClientIds,
  ];

  for (const accountId of mintTargets) {
    await mintTokens(tusdcAccount, tusdcId, accountId, DEMO_MINT_AMOUNT);
  }
  console.log('\n  ✅  Minting complete\n');

  // ── Step 7: Update deployments/testnet.json ───────────────────────────────
  console.log('── Step 7: Updating deployments/testnet.json ────────────────────');

  const existing = readDeployments();
  const deployments = {
    ...existing,
    network:     'testnet',
    parent:       PARENT,
    token_id:    tusdcId,
    core_id:     coreId,
    judge_id:    judgeId,
    panel_id:    panelId,
    accounts: {
      ...(existing.accounts || {}),
      core:          coreId,
      tusdc:         tusdcId,
      judge:         judgeId,
      panel:         panelId,
      client:        clientId,
      honest_agent:  `honest-agent.${PARENT}`,
      sloppy_agent:  `sloppy-agent.${PARENT}`,
      cheater_agent: `cheater-agent.${PARENT}`,
      fake_client_1: `fake-client-1.${PARENT}`,
      fake_client_2: `fake-client-2.${PARENT}`,
      fake_client_3: `fake-client-3.${PARENT}`,
      backer:        backerId,
    },
    token_wasm_bytes:    tokenWasm.byteLength,
    contract_wasm_bytes: contractWasm.byteLength,
    deployed_at:         new Date().toISOString(),
  };

  writeDeployments(deployments);
  console.log('  ✅  deployments/testnet.json updated\n');

  // ── Security check: make sure no secrets sneak into git ───────────────────
  console.log('── Security check ───────────────────────────────────────────────');
  try {
    const diff = execSync('git diff --cached --name-only', { cwd: ROOT }).toString();
    const dangerous = diff.split('\n').filter(f =>
      f.includes('.env') || f.toLowerCase().includes('private') || f.includes('secret')
    );
    if (dangerous.length > 0) {
      console.error('❌  SECURITY ALERT: staged files may contain secrets:');
      dangerous.forEach(f => console.error(`     ${f}`));
      console.error('    Unstage them before committing!');
      process.exit(1);
    }
    console.log('  ✅  No secrets detected in staged files\n');
  } catch {
    // git not available or not in a repo — skip check
    console.log('  ⚠  git check skipped (not a git repo or git unavailable)\n');
  }

  // ── Final summary ─────────────────────────────────────────────────────────
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║   Deployment live on NEAR testnet!                               ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝\n');
  console.log('  Token contract  :', tusdcId);
  console.log('  Core contract   :', coreId);
  console.log('  Judge account   :', judgeId);
  console.log('  Panel account   :', panelId);
  console.log('');
  console.log('  Explorer links:');
  console.log(`    https://testnet.nearblocks.io/address/${coreId}`);
  console.log(`    https://testnet.nearblocks.io/address/${tusdcId}`);
  console.log('');
  console.log('  Point the judge service at:');
  console.log(`    CONTRACT_ID=${coreId}`);
  console.log(`    TOKEN_ID=${tusdcId}`);
  console.log(`    JUDGE_ACCOUNT=${judgeId}`);
  console.log('');
  console.log('  Next step: node scripts/demo.mjs\n');
}

// Only auto-run when this file is the entry point (not when imported).
if (process.argv[1] && new URL(import.meta.url).pathname.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  main().catch(err => {
    console.error('\n❌  Deploy failed:', err);
    process.exit(1);
  });
}
export { main };

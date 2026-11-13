/**
 * scripts/setup-testnet.mjs
 *
 * Idempotent testnet bootstrap for Surety (NEAR Hackathon 2026).
 *
 * What it does
 * ────────────
 * 1. Reads NEAR_PARENT + NEAR_PARENT_PRIVATE_KEY from .env
 * 2. Creates all required sub-accounts (skips existing ones)
 * 3. Adds restricted function-call access keys:
 *      • judge  → submit_verdict, settle         on core.<parent>
 *      • agents → register_agent, accept_job, deliver  on core.<parent>
 * 4. Registers storage deposits on tusdc.<parent> for every sub-account
 * 5. Writes private keys ONLY to .env  (git-ignored)
 * 6. Writes public account IDs to     deployments/testnet.json  (safe to commit)
 *
 * Usage
 * ─────
 *   cp .env.example .env     # fill in NEAR_PARENT and NEAR_PARENT_PRIVATE_KEY
 *   node scripts/setup-testnet.mjs
 */

import 'dotenv/config';
import {
  nearConnect, loadKey, generateKey, createSubAccount, addFunctionCallKey,
  registerStorageDeposit, upsertEnv, readDeployments, writeDeployments,
  accountIdToEnvKey, getAccount, accountExists,
  SUBACCOUNT_INITIAL_BALANCE, ACCESS_KEY_ALLOWANCE, DEFAULT_GAS,
  keyStore, NETWORK_ID,
} from './lib/near.mjs';

// ── Validate environment ──────────────────────────────────────────────────────

const PARENT = process.env.NEAR_PARENT?.trim();
const PARENT_KEY = process.env.NEAR_PARENT_PRIVATE_KEY?.trim();

if (!PARENT || !PARENT_KEY) {
  console.error('❌  Missing NEAR_PARENT or NEAR_PARENT_PRIVATE_KEY in .env');
  console.error('    Copy .env.example to .env and fill in both values.');
  process.exit(1);
}

// ── Account roster ────────────────────────────────────────────────────────────

/**
 * All sub-accounts we need to create.
 * `prefix` is the part before `.<parent>`.
 * `role`   is a human-readable label used in console output.
 */
const ACCOUNTS = [
  { prefix: 'core',          role: 'Surety contract'   },
  { prefix: 'tusdc',         role: 'Mock token'        },
  { prefix: 'judge',         role: 'Judge service'     },
  { prefix: 'panel',         role: 'Appeal panel'      },
  { prefix: 'client',        role: 'Demo client'       },
  { prefix: 'honest-agent',  role: 'Honest agent'      },
  { prefix: 'sloppy-agent',  role: 'Sloppy agent'      },
  { prefix: 'cheater-agent', role: 'Cheater agent'     },
  { prefix: 'fake-client-1', role: 'Fake client 1'     },
  { prefix: 'fake-client-2', role: 'Fake client 2'     },
  { prefix: 'fake-client-3', role: 'Fake client 3'     },
  { prefix: 'backer',        role: 'Demo backer'       },
];

const AGENT_PREFIXES = ['honest-agent', 'sloppy-agent', 'cheater-agent'];
const JUDGE_PREFIX   = 'judge';

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   Surety — Testnet Setup                     ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  console.log(`Parent account : ${PARENT}`);
  console.log(`Network        : testnet\n`);

  // ── Load parent key ───────────────────────────────────────────────────────
  loadKey(PARENT, PARENT_KEY);
  const near   = await nearConnect();
  const parent = await near.account(PARENT);

  // Verify parent exists and has enough balance.
  const parentState = await parent.state();
  const parentBalNEAR = Number(BigInt(parentState.amount) / BigInt('1000000000000000000000000'));
  console.log(`Parent balance : ~${parentBalNEAR} NEAR\n`);

  if (BigInt(parentState.amount) < SUBACCOUNT_INITIAL_BALANCE * BigInt(ACCOUNTS.length + 2)) {
    console.warn('⚠  Parent balance may be low — you might need to top up via faucet.testnet.near.org');
  }

  // ── Step 1: Create sub-accounts ───────────────────────────────────────────
  console.log('── Step 1: Creating sub-accounts ───────────────────────────────');
  const createdAccounts = {};
  const envUpdates = {};

  for (const { prefix, role } of ACCOUNTS) {
    const accountId = `${prefix}.${PARENT}`;
    console.log(`  Creating ${accountId}  (${role})`);

    const result = await createSubAccount(
      near,
      parent,
      accountId,
      SUBACCOUNT_INITIAL_BALANCE,
    );

    createdAccounts[prefix] = result.accountId;

    // Always persist the key — upsertEnv is idempotent.
    const envKey = accountIdToEnvKey(accountId) + '_PRIVATE_KEY';
    envUpdates[envKey] = result.privateKey;
  }

  // Persist all private keys to .env.
  upsertEnv(envUpdates);
  console.log('\n  ✅  All sub-account private keys written to .env\n');

  // ── Step 2: Restricted function-call keys ─────────────────────────────────
  console.log('── Step 2: Adding restricted function-call access keys ─────────');
  const coreId = `core.${PARENT}`;
  const fcKeyUpdates = {};

  // Judge: submit_verdict + settle
  {
    const judgeId = `${JUDGE_PREFIX}.${PARENT}`;
    const judgeEnvBase = accountIdToEnvKey(judgeId);
    const existingFcKey = process.env[`${judgeEnvBase}_FC_KEY`];

    if (existingFcKey) {
      console.log(`  ✓ Judge FC key already recorded — skipping`);
    } else {
      const judgeAccount = await getAccount(near, judgeId);
      console.log(`  Adding judge FC key → submit_verdict, settle on ${coreId}`);
      const { publicKey, privateKey } = await addFunctionCallKey(
        judgeAccount,
        coreId,
        ['submit_verdict', 'settle'],
        ACCESS_KEY_ALLOWANCE,
      );
      fcKeyUpdates[`${judgeEnvBase}_FC_KEY`] = privateKey;
      fcKeyUpdates[`${judgeEnvBase}_FC_PUBLIC_KEY`] = publicKey;
      console.log(`  ✓ Judge FC key: ${publicKey}`);
    }
  }

  // Agents: register_agent, accept_job, deliver
  for (const prefix of AGENT_PREFIXES) {
    const agentId   = `${prefix}.${PARENT}`;
    const agentBase = accountIdToEnvKey(agentId);
    const existingFcKey = process.env[`${agentBase}_FC_KEY`];

    if (existingFcKey) {
      console.log(`  ✓ ${agentId} FC key already recorded — skipping`);
      continue;
    }

    // Load the agent's full-access key so we can call addKey.
    const agentPrivKey = process.env[`${agentBase}_PRIVATE_KEY`]
      || fcKeyUpdates[`${agentBase}_PRIVATE_KEY`]
      || envUpdates[`${agentBase}_PRIVATE_KEY`];

    if (!agentPrivKey) {
      console.warn(`  ⚠  No private key found for ${agentId} — skipping FC key`);
      continue;
    }
    loadKey(agentId, agentPrivKey);
    const agentAccount = await near.account(agentId);

    console.log(`  Adding agent FC key for ${agentId} → register_agent, accept_job, deliver`);
    const { publicKey, privateKey } = await addFunctionCallKey(
      agentAccount,
      coreId,
      ['register_agent', 'accept_job', 'deliver'],
      ACCESS_KEY_ALLOWANCE,
    );
    fcKeyUpdates[`${agentBase}_FC_KEY`] = privateKey;
    fcKeyUpdates[`${agentBase}_FC_PUBLIC_KEY`] = publicKey;
    console.log(`  ✓ ${agentId} FC key: ${publicKey}`);
  }

  if (Object.keys(fcKeyUpdates).length > 0) {
    upsertEnv(fcKeyUpdates);
    console.log('\n  ✅  Function-call keys written to .env\n');
  } else {
    console.log('  ✅  All FC keys already present\n');
  }

  // ── Step 3: Storage deposits on tusdc.<parent> ────────────────────────────
  console.log('── Step 3: Registering storage deposits on tusdc token ──────────');
  const tusdcId    = `tusdc.${PARENT}`;
  const tusdcPrivKey = process.env[accountIdToEnvKey(tusdcId) + '_PRIVATE_KEY']
    || envUpdates[accountIdToEnvKey(tusdcId) + '_PRIVATE_KEY'];

  if (!tusdcPrivKey) {
    console.error('  ❌  No private key for tusdc account — cannot register storage');
    console.error('      Ensure setup has been run once to create the tusdc sub-account.');
    process.exit(1);
  }

  loadKey(tusdcId, tusdcPrivKey);
  const tusdcAccount = await near.account(tusdcId);

  // Check if tusdc contract is deployed first (skip storage if not yet deployed).
  let tusdcDeployed = false;
  try {
    const tusdcState = await tusdcAccount.state();
    tusdcDeployed = tusdcState.code_hash !== '11111111111111111111111111111111';
  } catch {
    tusdcDeployed = false;
  }

  if (!tusdcDeployed) {
    console.log('  ⚠  tusdc contract not yet deployed — skipping storage registration.');
    console.log('     Run scripts/deploy.mjs first, then re-run setup-testnet.mjs.\n');
  } else {
    for (const { prefix } of ACCOUNTS) {
      const accountId = `${prefix}.${PARENT}`;
      await registerStorageDeposit(tusdcAccount, tusdcId, accountId);
    }
    // Also register the parent account itself.
    await registerStorageDeposit(tusdcAccount, tusdcId, PARENT);
    // And register core (Surety contract holds tokens in escrow).
    await registerStorageDeposit(tusdcAccount, tusdcId, `core.${PARENT}`);
    console.log('  ✅  All accounts registered on tusdc\n');
  }

  // ── Step 4: Write deployments/testnet.json ────────────────────────────────
  console.log('── Step 4: Writing deployments/testnet.json ─────────────────────');

  const existing = readDeployments();
  const deployments = {
    ...existing,
    network:       'testnet',
    parent:         PARENT,
    token_id:      `tusdc.${PARENT}`,
    core_id:       `core.${PARENT}`,
    judge_id:      `judge.${PARENT}`,
    panel_id:      `panel.${PARENT}`,
    accounts: {
      core:          `core.${PARENT}`,
      tusdc:         `tusdc.${PARENT}`,
      judge:         `judge.${PARENT}`,
      panel:         `panel.${PARENT}`,
      client:        `client.${PARENT}`,
      honest_agent:  `honest-agent.${PARENT}`,
      sloppy_agent:  `sloppy-agent.${PARENT}`,
      cheater_agent: `cheater-agent.${PARENT}`,
      fake_client_1: `fake-client-1.${PARENT}`,
      fake_client_2: `fake-client-2.${PARENT}`,
      fake_client_3: `fake-client-3.${PARENT}`,
      backer:        `backer.${PARENT}`,
    },
    setup_at: new Date().toISOString(),
  };

  writeDeployments(deployments);
  console.log(`  ✅  Written to deployments/testnet.json\n`);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   Setup complete!                            ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  console.log('  Token contract  :', `tusdc.${PARENT}`);
  console.log('  Core contract   :', `core.${PARENT}`);
  console.log('  Judge account   :', `judge.${PARENT}`);
  console.log('  Panel account   :', `panel.${PARENT}`);
  console.log('\n  Next step: run  node scripts/deploy.mjs\n');
  console.log('  ⚠  .env contains private keys — never commit it to git.\n');
}

// Only auto-run when this file is the entry point (not when imported).
if (process.argv[1] && new URL(import.meta.url).pathname.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  main().catch(err => {
    console.error('\n❌  Setup failed:', err);
    process.exit(1);
  });
}
export { main };

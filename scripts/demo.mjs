/**
 * scripts/demo.mjs
 *
 * End-to-end demo on NEAR testnet:
 *   post_job → accept_job → deliver → submit_verdict → settle
 *
 * Reads account IDs from deployments/testnet.json and private keys from .env.
 * Logs a NearBlocks explorer link for every transaction.
 *
 * Usage
 * ─────
 *   node scripts/demo.mjs
 *
 * Optional env overrides
 * ──────────────────────
 *   DEMO_JOB_VALUE   Raw tUSDC units for the job value  (default: 50000000 = 50 tUSDC)
 *   DEMO_SCORE_BPS   Judge score in basis points         (default: 10000  = Pass)
 */

import 'dotenv/config';
import {
  nearConnect, loadKey, getAccount, readDeployments,
  accountIdToEnvKey, DEFAULT_GAS, NETWORK_ID,
} from './lib/near.mjs';

// ── Constants ─────────────────────────────────────────────────────────────────

const EXPLORER  = 'https://testnet.nearblocks.io/txns';
const JOB_VALUE = process.env.DEMO_JOB_VALUE  ?? '50000000';   // 50 tUSDC
const SCORE_BPS = Number(process.env.DEMO_SCORE_BPS ?? '10000'); // Pass

/** Fake SHA-256 spec hash (64 hex chars) for the demo job */
const SPEC_HASH = 'a'.repeat(64);
const SPEC_URL  = 'https://github.com/surety-demo/spec/blob/main/demo-job.md';

/** Fake patch hash delivered by agent */
const PATCH_HASH = 'b'.repeat(64);
const PATCH_URL  = 'https://github.com/surety-demo/patches/blob/main/demo-patch.diff';

/** Deadline 30 minutes from now (epoch ms) */
const DEADLINE_MS = Date.now() + 30 * 60 * 1000;

/** Appeal window is 2 min; we wait 125 s after verdict before settling */
const APPEAL_WAIT_MS = 125_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function txLink(hash) {
  return `${EXPLORER}/${hash}`;
}

function logTx(step, hash) {
  console.log(`\n  ✅  ${step}`);
  console.log(`     tx: ${txLink(hash)}`);
}

/**
 * Load a private key from .env for an account and return a loaded Account.
 * Throws clearly if the key is missing.
 */
async function loadAcc(near, accountId) {
  const envKey = accountIdToEnvKey(accountId) + '_PRIVATE_KEY';
  const privKey = process.env[envKey];
  if (!privKey) {
    throw new Error(
      `No private key in .env for "${accountId}"\n` +
      `  Expected env var: ${envKey}\n` +
      `  Run scripts/setup-testnet.mjs first.`
    );
  }
  loadKey(accountId, privKey);
  return near.account(accountId);
}

/**
 * ft_transfer_call helper — sends tUSDC with a JSON msg to the core contract.
 * Returns the transaction outcome.
 */
async function ftTransferCall(senderAccount, tokenId, coreId, amount, msg) {
  return senderAccount.functionCall({
    contractId:      tokenId,
    methodName:      'ft_transfer_call',
    args:             {
      receiver_id: coreId,
      amount:      amount,
      memo:        null,
      msg:         JSON.stringify(msg),
    },
    gas:              DEFAULT_GAS * 3n,          // cross-contract needs more gas
    attachedDeposit:  1n,                        // 1 yoctoNEAR required by NEP-141
  });
}

/**
 * Sleep for `ms` milliseconds, printing a countdown every 10 s.
 */
async function sleep(ms, label) {
  const end = Date.now() + ms;
  process.stdout.write(`\n  ⏳  ${label} `);
  while (Date.now() < end) {
    const remaining = Math.ceil((end - Date.now()) / 1000);
    process.stdout.write(`${remaining}s… `);
    await new Promise(r => setTimeout(r, Math.min(10_000, end - Date.now())));
  }
  console.log('done.\n');
}

/**
 * Extract the transaction hash from a function-call outcome object.
 * near-api-js v5 returns it in outcome.transaction.hash.
 */
function txHash(outcome) {
  return outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id ?? '(hash unavailable)';
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  console.log('║   Surety — End-to-End Demo                                       ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝\n');

  // ── Load deployment config ────────────────────────────────────────────────
  const deps = readDeployments();
  if (!deps.core_id || !deps.token_id) {
    console.error('❌  deployments/testnet.json is not populated.');
    console.error('    Run scripts/setup-testnet.mjs and scripts/deploy.mjs first.');
    process.exit(1);
  }

  const { core_id: coreId, token_id: tokenId, judge_id: judgeId } = deps;
  const clientId = deps.accounts?.client;
  const agentId  = deps.accounts?.honest_agent;

  if (!clientId || !agentId || !judgeId) {
    console.error('❌  Missing account IDs in deployments/testnet.json.');
    console.error('    Re-run scripts/setup-testnet.mjs to regenerate.');
    process.exit(1);
  }

  console.log('  Contract  :', coreId);
  console.log('  Token     :', tokenId);
  console.log('  Client    :', clientId);
  console.log('  Agent     :', agentId);
  console.log('  Judge     :', judgeId);
  console.log('  Job value :', JOB_VALUE, 'units (', Number(JOB_VALUE) / 1e6, 'tUSDC)');
  console.log('  Score bps :', SCORE_BPS, `(${SCORE_BPS === 10000 ? 'Pass' : SCORE_BPS >= 5000 ? 'Partial' : 'Fail'})`);
  console.log('');

  // ── Build NEAR connection and load accounts ───────────────────────────────
  const PARENT     = process.env.NEAR_PARENT?.trim();
  const PARENT_KEY = process.env.NEAR_PARENT_PRIVATE_KEY?.trim();
  if (!PARENT || !PARENT_KEY) {
    throw new Error('NEAR_PARENT / NEAR_PARENT_PRIVATE_KEY missing from .env');
  }
  loadKey(PARENT, PARENT_KEY);

  const near         = await nearConnect();
  const clientAcc    = await loadAcc(near, clientId);
  const agentAcc     = await loadAcc(near, agentId);
  const judgeAcc     = await loadAcc(near, judgeId);

  // ── Step 1: Register agent (idempotent) ──────────────────────────────────
  console.log('── Step 1: register_agent ───────────────────────────────────────');
  try {
    const r = await agentAcc.functionCall({
      contractId:     coreId,
      methodName:     'register_agent',
      args:            {},
      gas:             DEFAULT_GAS,
      attachedDeposit: 0n,
    });
    logTx('Agent registered', txHash(r));
  } catch (err) {
    if (err.message?.includes('already registered')) {
      console.log('  ✓  Agent already registered — skipping');
    } else {
      throw err;
    }
  }

  // ── Step 2: Bond agent (100 tUSDC minimum) ────────────────────────────────
  console.log('\n── Step 2: Bond agent (100 tUSDC via ft_transfer_call) ──────────');
  try {
    const r = await ftTransferCall(agentAcc, tokenId, coreId, '100000000', { action: 'bond' });
    logTx('Bond deposited', txHash(r));
  } catch (err) {
    // Bond might already be above minimum from a previous run — not fatal.
    console.log(`  ⚠  Bond step error (agent may already be bonded): ${err.message}`);
  }

  // ── Step 3: Post job (client ft_transfer_call) ────────────────────────────
  console.log('\n── Step 3: post_job (client ft_transfer_call) ───────────────────');
  const postMsg = {
    action:        'post_job',
    spec_hash:      SPEC_HASH,
    spec_url:       SPEC_URL,
    min_score_bps:  5000,
    deadline_ms:    DEADLINE_MS,
  };

  const postResult = await ftTransferCall(clientAcc, tokenId, coreId, JOB_VALUE, postMsg);
  const postTxHash = txHash(postResult);
  logTx('Job posted', postTxHash);

  // Extract job_id from the event logs.
  let jobId = null;
  const logs = postResult?.receipts_outcome?.flatMap(r => r.outcome?.logs ?? []) ?? [];
  for (const log of logs) {
    if (log.startsWith('EVENT_JSON:')) {
      try {
        const event = JSON.parse(log.slice('EVENT_JSON:'.length));
        if (event.event === 'job_posted') {
          jobId = event.data[0]?.job_id;
          break;
        }
      } catch { /* ignore parse errors */ }
    }
  }

  if (jobId === null || jobId === undefined) {
    // Fall back: query the latest job via list_jobs.
    console.log('  ℹ  Could not parse job_id from logs — querying list_jobs…');
    try {
      const jobs = await clientAcc.viewFunction({
        contractId: coreId,
        methodName: 'list_jobs',
        args:        { from_index: 0, limit: 1 },
      });
      if (jobs.length > 0) {
        jobId = jobs[0].job_id;
        console.log(`  ℹ  Got job_id=${jobId} from list_jobs`);
      }
    } catch { /* ignore */ }
  }

  if (jobId === null || jobId === undefined) {
    throw new Error('Could not determine job_id — check the transaction logs above.');
  }
  console.log(`\n  Job ID: ${jobId}`);

  // ── Step 4: Accept job ────────────────────────────────────────────────────
  console.log('\n── Step 4: accept_job ───────────────────────────────────────────');
  const acceptResult = await agentAcc.functionCall({
    contractId:     coreId,
    methodName:     'accept_job',
    args:            { job_id: jobId },
    gas:             DEFAULT_GAS,
    attachedDeposit: 0n,
  });
  logTx('Job accepted', txHash(acceptResult));

  // ── Step 5: Deliver job ───────────────────────────────────────────────────
  console.log('\n── Step 5: deliver ──────────────────────────────────────────────');
  const deliverResult = await agentAcc.functionCall({
    contractId:     coreId,
    methodName:     'deliver',
    args:            {
      job_id:     jobId,
      patch_url:  PATCH_URL,
      patch_hash: PATCH_HASH,
    },
    gas:             DEFAULT_GAS,
    attachedDeposit: 0n,
  });
  logTx('Job delivered', txHash(deliverResult));

  // ── Step 6: Submit verdict ────────────────────────────────────────────────
  console.log('\n── Step 6: submit_verdict ───────────────────────────────────────');
  const verdictResult = await judgeAcc.functionCall({
    contractId:     coreId,
    methodName:     'submit_verdict',
    args:            {
      job_id:        jobId,
      score_bps:     SCORE_BPS,
      checks_passed: 10,
      checks_total:  10,
      receipts_hash: 'c'.repeat(64),
    },
    gas:             DEFAULT_GAS,
    attachedDeposit: 0n,
  });
  logTx(`Verdict submitted (score=${SCORE_BPS} bps)`, txHash(verdictResult));

  // ── Step 7: Wait for appeal window to close, then settle ─────────────────
  console.log('\n── Step 7: settle (after appeal window) ─────────────────────────');
  await sleep(APPEAL_WAIT_MS, 'Waiting for 2-min appeal window to close…');

  // Anyone can call settle once the window has closed; use the judge account.
  const settleResult = await judgeAcc.functionCall({
    contractId:     coreId,
    methodName:     'settle',
    args:            { job_id: jobId },
    gas:             DEFAULT_GAS * 3n,  // settle triggers cross-contract ft_transfer calls
    attachedDeposit: 0n,
  });
  logTx('Job settled', txHash(settleResult));

  // ── Final summary ─────────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  console.log('║   Demo complete!                                                  ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝\n');
  console.log('  Transactions:');
  console.log('    post_job        :', txLink(postTxHash));
  console.log('    accept_job      :', txLink(txHash(acceptResult)));
  console.log('    deliver         :', txLink(txHash(deliverResult)));
  console.log('    submit_verdict  :', txLink(txHash(verdictResult)));
  console.log('    settle          :', txLink(txHash(settleResult)));
  console.log('');
  console.log('  Contract explorer :', `https://testnet.nearblocks.io/address/${coreId}`);
  console.log('  Token explorer    :', `https://testnet.nearblocks.io/address/${tokenId}`);
  console.log('');

  // Print final job state.
  try {
    const jobView = await judgeAcc.viewFunction({
      contractId: coreId,
      methodName: 'get_job',
      args:        { job_id: jobId },
    });
    console.log('  Final job state:');
    console.log('   ', JSON.stringify(jobView, null, 4).replace(/\n/g, '\n    '));
  } catch (e) {
    console.log('  (Could not fetch final job state:', e.message, ')');
  }
  console.log('');
}

// Only auto-run when this file is the entry point (not when imported).
if (process.argv[1] && new URL(import.meta.url).pathname.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  main().catch(err => {
    console.error('\n❌  Demo failed:', err);
    process.exit(1);
  });
}
export { main };

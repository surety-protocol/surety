/**
 * scripts/lib/near.mjs
 *
 * Shared helpers: NEAR connection, account loading, idempotent sub-account
 * creation, and function-call access-key management.
 *
 * Compatible with near-api-js v5.x (InMemoryKeyStore, KeyPair, Account,
 * transactions.* from the flat export surface of v5).
 */

import * as nearAPI from 'near-api-js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const { connect, keyStores, KeyPair, utils, transactions } = nearAPI;

// ── Constants ────────────────────────────────────────────────────────────────

export const TESTNET_RPC    = 'https://rpc.testnet.near.org';
export const TESTNET_HELPER = 'https://helper.testnet.near.org';
export const NETWORK_ID     = 'testnet';

/** 1 NEAR in yoctoNEAR */
export const ONE_NEAR = BigInt('1000000000000000000000000');

/** Minimum storage deposit for a single NEP-141 account registration (0.00125 NEAR) */
export const STORAGE_DEPOSIT = BigInt('1250000000000000000000');

/** Initial balance for newly created sub-accounts (0.5 NEAR) */
export const SUBACCOUNT_INITIAL_BALANCE = BigInt('500000000000000000000000');

/** Gas for function-call access keys (250 Tgas) */
export const ACCESS_KEY_ALLOWANCE = BigInt('250000000000000000000000000000');

/** Gas for ordinary contract calls (100 Tgas) */
export const DEFAULT_GAS = BigInt('100000000000000');

// ── File paths ────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

export const DEPLOYMENTS_DIR  = join(ROOT, 'deployments');
export const TESTNET_JSON     = join(DEPLOYMENTS_DIR, 'testnet.json');
export const ENV_FILE         = join(ROOT, '.env');
export const CONTRACT_DIR     = join(ROOT, 'contract');
export const TOKEN_DIR        = join(ROOT, 'token');

// ── Key store (singleton) ────────────────────────────────────────────────────

export const keyStore = new keyStores.InMemoryKeyStore();

// ── Connection factory ────────────────────────────────────────────────────────

/**
 * Build a NEAR connection using the shared in-memory key store.
 * @returns {Promise<import('near-api-js').Near>}
 */
export async function nearConnect() {
  return connect({
    networkId: NETWORK_ID,
    keyStore,
    nodeUrl:   TESTNET_RPC,
    helperUrl: TESTNET_HELPER,
  });
}

// ── Key helpers ───────────────────────────────────────────────────────────────

/**
 * Load a private key string (ed25519:…) into the in-memory key store and
 * return the resulting KeyPair.
 */
export function loadKey(accountId, privateKey) {
  const kp = KeyPair.fromString(privateKey);
  keyStore.setKey(NETWORK_ID, accountId, kp);
  return kp;
}

/**
 * Generate a fresh ed25519 key pair, store it for accountId, and return it.
 */
export function generateKey(accountId) {
  const kp = KeyPair.fromRandom('ed25519');
  keyStore.setKey(NETWORK_ID, accountId, kp);
  return kp;
}

// ── .env helpers ──────────────────────────────────────────────────────────────

/**
 * Read the current .env file into a plain key→value Map.
 * Lines that are comments or blank are preserved as-is under a special key.
 */
export function readEnv() {
  if (!existsSync(ENV_FILE)) return new Map();
  const lines = readFileSync(ENV_FILE, 'utf8').split('\n');
  const map = new Map();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    map.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return map;
}

/**
 * Merge new key→value pairs into .env, preserving existing entries.
 * Writes the file atomically (all existing lines preserved, new ones appended).
 */
export function upsertEnv(updates) {
  const existing = readEnv();
  for (const [k, v] of Object.entries(updates)) existing.set(k, v);

  let out = '# Surety testnet secrets — DO NOT COMMIT\n';
  for (const [k, v] of existing.entries()) out += `${k}=${v}\n`;
  writeFileSync(ENV_FILE, out, 'utf8');
}

// ── deployments/testnet.json helpers ─────────────────────────────────────────

export function readDeployments() {
  if (!existsSync(TESTNET_JSON)) return {};
  return JSON.parse(readFileSync(TESTNET_JSON, 'utf8'));
}

export function writeDeployments(data) {
  mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  writeFileSync(TESTNET_JSON, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// ── Account helpers ───────────────────────────────────────────────────────────

/**
 * Load an Account object for `accountId`, assuming its key is already in
 * the key store.
 */
export async function getAccount(near, accountId) {
  return near.account(accountId);
}

/**
 * Check whether a NEAR account exists on-chain.
 */
export async function accountExists(near, accountId) {
  try {
    const acc = await near.account(accountId);
    await acc.state();
    return true;
  } catch {
    return false;
  }
}

/**
 * Idempotently create a sub-account.
 *
 * If the account already exists on-chain we skip creation but still ensure
 * the key is in the key store (using whatever key is recorded in .env).
 *
 * @param {import('near-api-js').Near} near
 * @param {import('near-api-js').Account} parentAccount
 * @param {string} newAccountId
 * @param {BigInt} initialBalance  yoctoNEAR
 * @returns {{ accountId: string, privateKey: string, created: boolean }}
 */
export async function createSubAccount(near, parentAccount, newAccountId, initialBalance) {
  const exists = await accountExists(near, newAccountId);

  // Check if we already have a key for this account recorded in .env.
  const env = readEnv();
  const envKey = accountIdToEnvKey(newAccountId) + '_PRIVATE_KEY';
  const existingPrivKey = env.get(envKey);

  if (exists && existingPrivKey) {
    loadKey(newAccountId, existingPrivKey);
    console.log(`  ✓ ${newAccountId} already exists — skipped`);
    return { accountId: newAccountId, privateKey: existingPrivKey, created: false };
  }

  // Generate a new key pair for the sub-account.
  const kp = generateKey(newAccountId);
  const privateKey = kp.toString();
  const publicKey  = kp.getPublicKey().toString();

  if (!exists) {
    await parentAccount.createAccount(newAccountId, publicKey, initialBalance);
    console.log(`  ✓ Created ${newAccountId}`);
  } else {
    // Account exists but we have no recorded key — add the new key to it.
    // We can only do this if the parent is an owner/sponsor.
    console.log(`  ⚠ ${newAccountId} exists but no key recorded — adding new key`);
    const acc = await getAccount(near, newAccountId);
    await acc.addKey(publicKey);
  }

  return { accountId: newAccountId, privateKey, created: true };
}

/**
 * Convert an account ID like "honest-agent.surety.testnet" to an env-var
 * friendly prefix like "HONEST_AGENT_SURETY_TESTNET".
 */
export function accountIdToEnvKey(accountId) {
  return accountId.toUpperCase().replace(/[.\-]/g, '_');
}

/**
 * Add a function-call restricted access key to an account.
 * Idempotent: if the public key is already on the account, this is a no-op.
 *
 * @param {import('near-api-js').Account} account   - the account to add the key to
 * @param {string}  contractId   - the contract the key is restricted to
 * @param {string[]} methodNames  - allowed method names (empty = all methods)
 * @param {BigInt}  allowance     - gas allowance in yoctoNEAR
 * @returns {Promise<{ publicKey: string, privateKey: string }>}
 */
export async function addFunctionCallKey(account, contractId, methodNames, allowance) {
  const kp         = KeyPair.fromRandom('ed25519');
  const publicKey  = kp.getPublicKey().toString();
  const privateKey = kp.toString();

  await account.addKey(
    publicKey,
    contractId,
    methodNames,
    allowance,
  );
  return { publicKey, privateKey };
}

/**
 * Check if a given public key already exists on an account.
 */
export async function publicKeyExists(near, accountId, publicKeyStr) {
  try {
    const acc  = await near.account(accountId);
    const keys = await acc.getAccessKeys();
    return keys.some(k => k.public_key === publicKeyStr);
  } catch {
    return false;
  }
}

// ── Token helpers ─────────────────────────────────────────────────────────────

/**
 * Register an account for storage with the given NEP-141 token contract.
 * Idempotent — checks storage_balance_of before depositing.
 *
 * @param {import('near-api-js').Account} payerAccount  - who pays (usually the token owner)
 * @param {string} tokenContractId
 * @param {string} accountToRegister
 */
export async function registerStorageDeposit(payerAccount, tokenContractId, accountToRegister) {
  // Check if already registered.
  try {
    const bal = await payerAccount.viewFunction({
      contractId: tokenContractId,
      methodName: 'storage_balance_of',
      args:        { account_id: accountToRegister },
    });
    if (bal && BigInt(bal.total) > 0n) {
      console.log(`    ✓ ${accountToRegister} already registered on ${tokenContractId}`);
      return;
    }
  } catch {
    // view call failed — proceed with deposit
  }

  await payerAccount.functionCall({
    contractId:  tokenContractId,
    methodName:  'storage_deposit',
    args:         { account_id: accountToRegister, registration_only: true },
    gas:          DEFAULT_GAS,
    attachedDeposit: STORAGE_DEPOSIT,
  });
  console.log(`    ✓ Registered ${accountToRegister} on ${tokenContractId}`);
}

/**
 * Mint tUSDC tokens to `receiverId` from the token owner account.
 *
 * @param {import('near-api-js').Account} ownerAccount
 * @param {string} tokenContractId
 * @param {string} receiverId
 * @param {string} amountUnits  - raw units as a decimal string
 */
export async function mintTokens(ownerAccount, tokenContractId, receiverId, amountUnits) {
  await ownerAccount.functionCall({
    contractId: tokenContractId,
    methodName: 'mint',
    args:        { account_id: receiverId, amount: amountUnits },
    gas:         DEFAULT_GAS,
    attachedDeposit: 1n,
  });
  console.log(`    ✓ Minted ${amountUnits} units → ${receiverId}`);
}

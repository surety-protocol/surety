// Shared helpers for the testnet scripts: .env handling, deployments/testnet.json,
// and small wrappers around near-api-js v7 (the same version shared/ uses).
// Testnet only: every entry point calls requireTestnet() first.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Account, JsonRpcProvider, KeyPair } from "near-api-js";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ENV_FILE = join(ROOT, ".env");
export const DEPLOYMENTS_FILE = join(ROOT, "deployments", "testnet.json");
export const EXPLORER = "https://testnet.nearblocks.io";

export const NEAR = 10n ** 24n;
export const TGAS = 10n ** 12n;
/** Storage cost on NEAR: 1e19 yoctoNEAR per byte (1 NEAR per 100 kB). */
export const STORAGE_PRICE_PER_BYTE = 10n ** 19n;

// ── Account roster (SPEC §3) and where each key lives in .env (SPEC §8) ──────

/** prefix -> env var holding that account's full-access key. */
export const ACCOUNTS = {
  core: "CORE_PRIVATE_KEY",
  tusdc: "TOKEN_PRIVATE_KEY",
  judge: "JUDGE_FULL_PRIVATE_KEY", // JUDGE_PRIVATE_KEY is the restricted key the judge service uses
  panel: "PANEL_PRIVATE_KEY",
  client: "CLIENT_PRIVATE_KEY",
  "honest-agent": "HONEST_AGENT_PRIVATE_KEY",
  "sloppy-agent": "SLOPPY_AGENT_PRIVATE_KEY",
  "cheater-agent": "CHEATER_AGENT_PRIVATE_KEY",
  "fake-client-1": "FAKE_CLIENT_1_PRIVATE_KEY",
  "fake-client-2": "FAKE_CLIENT_2_PRIVATE_KEY",
  "fake-client-3": "FAKE_CLIENT_3_PRIVATE_KEY",
  backer: "BACKER_PRIVATE_KEY",
};
export const AGENTS = ["honest-agent", "sloppy-agent", "cheater-agent"];

/** NEAR each sub-account starts with. core and tusdc get topped up by deploy.mjs for their code. */
export const INITIAL_NEAR = { judge: 2n * NEAR, default: NEAR / 2n };

// ── .env ─────────────────────────────────────────────────────────────────────

export function loadEnv() {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
}

/**
 * Set keys in .env. Existing lines (comments included) stay where they are;
 * a key that is already there gets its value replaced, new keys are appended.
 * Also updates process.env so later steps in the same run see the values.
 */
export function setEnv(updates) {
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8").split(/\r?\n/) : [];
  const left = new Map(Object.entries(updates));
  const out = lines.map((line) => {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (m && left.has(m[1])) {
      const v = left.get(m[1]);
      left.delete(m[1]);
      return `${m[1]}=${v}`;
    }
    return line;
  });
  while (out.length && out[out.length - 1] === "") out.pop();
  for (const [k, v] of left) out.push(`${k}=${v}`);
  writeFileSync(ENV_FILE, out.join("\n") + "\n", "utf8");
  for (const [k, v] of Object.entries(updates)) process.env[k] = v;
}

export function env(name) {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

export function requireEnv(name, hint = "see .env.example") {
  const v = env(name);
  if (!v) fail(`Missing ${name} in .env (${hint}).`);
  return v;
}

/** Refuse to run anywhere but testnet. */
export function requireTestnet() {
  loadEnv();
  if ((env("NEAR_NETWORK") ?? "testnet") !== "testnet") fail("NEAR_NETWORK must be testnet. Surety never touches mainnet.");
  const parent = requireEnv("NEAR_PARENT");
  if (!parent.endsWith(".testnet")) fail(`NEAR_PARENT must be a .testnet account, got ${parent}.`);
  const rpcUrl = requireEnv("NEAR_RPC_URL", "pick a testnet RPC from https://docs.near.org/api/rpc/providers");
  if (/mainnet/i.test(rpcUrl)) fail(`NEAR_RPC_URL looks like a mainnet endpoint: ${rpcUrl}`);
  return { parent, rpcUrl };
}

export function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

// ── deployments/testnet.json (public ids only, read by shared/src/env.ts) ────

export function readDeployments() {
  return existsSync(DEPLOYMENTS_FILE) ? JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8")) : {};
}

export function writeDeployments(patch) {
  const next = { ...readDeployments(), ...patch };
  mkdirSync(dirname(DEPLOYMENTS_FILE), { recursive: true });
  writeFileSync(DEPLOYMENTS_FILE, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

export function deploymentFor(parent) {
  const accounts = Object.fromEntries(Object.keys(ACCOUNTS).map((p) => [p.replace(/-/g, "_"), `${p}.${parent}`]));
  return {
    network: "testnet",
    parent,
    contract_id: `core.${parent}`,
    token_id: `tusdc.${parent}`,
    judge_id: `judge.${parent}`,
    panel_id: `panel.${parent}`,
    accounts,
  };
}

// ── Chain helpers ─────────────────────────────────────────────────────────────

export function connect(rpcUrl) {
  const provider = new JsonRpcProvider({ url: rpcUrl });
  return {
    provider,
    /** An account that can sign with `key` (or a read-only one without). */
    account: (id, key) => new Account(id, provider, key),
    async exists(id) {
      try {
        await new Account(id, provider).getState();
        return true;
      } catch (e) {
        if (/does not exist|UNKNOWN_ACCOUNT|doesn't exist/i.test(String(e?.message ?? e))) return false;
        throw e;
      }
    },
    view: (contractId, method, args = {}) => provider.callFunction({ contractId, method, args }),
  };
}

/** A function call that throws if the transaction or any receipt failed. Returns { tx, logs, value }. */
export async function call(account, contractId, methodName, args = {}, { deposit = 0n, gas = 100n * TGAS } = {}) {
  const r = await account.callFunctionRaw({ contractId, methodName, args, deposit, gas });
  const failure =
    (r.status && "Failure" in r.status && r.status.Failure) ||
    r.receipts_outcome?.find((x) => x.outcome?.status && "Failure" in x.outcome.status)?.outcome.status.Failure;
  if (failure) throw new Error(`${methodName} on ${contractId} failed: ${JSON.stringify(failure)} (${txUrl(r.transaction.hash)})`);
  let value;
  if (r.status?.SuccessValue) {
    const text = Buffer.from(r.status.SuccessValue, "base64").toString("utf8");
    try {
      value = JSON.parse(text);
    } catch {
      value = text;
    }
  }
  return { tx: r.transaction.hash, logs: r.receipts_outcome.flatMap((x) => x.outcome.logs), value };
}

/** NEP-297 events (EVENT_JSON:...) from transaction logs. */
export function events(logs) {
  return logs
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => {
      try {
        return JSON.parse(l.slice("EVENT_JSON:".length));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function newKey() {
  const kp = KeyPair.fromRandom("ed25519");
  return { secret: kp.toString(), publicKey: kp.getPublicKey().toString() };
}

export function publicKeyOf(secret) {
  return KeyPair.fromString(secret).getPublicKey().toString();
}

export const txUrl = (hash) => `${EXPLORER}/txns/${hash}`;
export const formatNear = (yocto) => (Number((BigInt(yocto) * 1000n) / NEAR) / 1000).toFixed(3);
export const formatTusdc = (units) => (Number(BigInt(units)) / 1e6).toFixed(2);

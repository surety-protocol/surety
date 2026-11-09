// Loads .env from the repo root (if present) and builds a SuretyChain from it.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NearChain, RpcTransport } from "./near.ts";
import type { SuretyChain } from "./chain.ts";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

let loaded = false;
export function loadEnv(file = join(REPO_ROOT, ".env")): void {
  if (loaded) return;
  loaded = true;
  if (existsSync(file)) process.loadEnvFile(file);
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing environment variable ${name} (see .env.example)`);
  return v;
}

export interface Deployment {
  network: "testnet";
  parent: string;
  contract_id: string;
  token_id: string;
  judge_id: string;
  panel_id: string;
  accounts: Record<string, string>;
}

/** deployments/testnet.json, written by Dev 1's setup script. */
export function readDeployment(file = join(REPO_ROOT, "deployments", "testnet.json")): Deployment | null {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as Deployment;
}

/**
 * Account id -> secret key, from env vars named in SPEC §8.
 * Only accounts whose key is present are included.
 */
export function keysFromEnv(): Map<string, string> {
  const parent = process.env.NEAR_PARENT;
  const keys = new Map<string, string>();
  const add = (account: string | undefined, key: string | undefined) => {
    if (account && key) keys.set(account, key);
  };
  add(process.env.JUDGE_ACCOUNT_ID ?? (parent && `judge.${parent}`), process.env.JUDGE_PRIVATE_KEY);
  if (parent) {
    add(`panel.${parent}`, process.env.PANEL_PRIVATE_KEY);
    add(`client.${parent}`, process.env.CLIENT_PRIVATE_KEY);
    add(`honest-agent.${parent}`, process.env.HONEST_AGENT_PRIVATE_KEY);
    add(`sloppy-agent.${parent}`, process.env.SLOPPY_AGENT_PRIVATE_KEY);
    add(`cheater-agent.${parent}`, process.env.CHEATER_AGENT_PRIVATE_KEY);
    add(`backer.${parent}`, process.env.BACKER_PRIVATE_KEY);
  }
  return keys;
}

export function nearChainFromEnv(): SuretyChain {
  loadEnv();
  if ((process.env.NEAR_NETWORK ?? "testnet") !== "testnet") throw new Error("Surety runs on testnet only");
  const dep = readDeployment();
  const contractId = process.env.SURETY_CONTRACT_ID || dep?.contract_id;
  const tokenId = process.env.TOKEN_ID || dep?.token_id;
  if (!contractId || !tokenId) throw new Error("SURETY_CONTRACT_ID and TOKEN_ID are not set and deployments/testnet.json is missing");
  return new NearChain(contractId, tokenId, new RpcTransport(requireEnv("NEAR_RPC_URL"), keysFromEnv()));
}

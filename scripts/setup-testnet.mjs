// npm run setup:testnet
//
// Creates the Surety testnet accounts under NEAR_PARENT (SPEC §3). Safe to re-run:
// accounts and keys that already exist are kept.
//
//   1. Creates the 12 sub-accounts (core, tusdc, judge, panel, client, 3 agents,
//      3 fake clients, backer). Each key is written to .env BEFORE the account is
//      created, so a crash never loses a key.
//   2. Adds restricted function-call keys:
//        judge  -> submit_verdict, settle on core   (JUDGE_PRIVATE_KEY, used by the judge service)
//        agents -> register_agent, accept_job, deliver (<AGENT>_FC_PRIVATE_KEY)
//   3. Writes SURETY_CONTRACT_ID, TOKEN_ID, JUDGE_ACCOUNT_ID to .env and the public
//      ids to deployments/testnet.json.
//
// Needs in .env: NEAR_PARENT, NEAR_PARENT_PRIVATE_KEY, NEAR_RPC_URL.
// Then run: npm run deploy
//
// Based on Osuochasam's script in surety-protocol/surety-contract#2.

import {
  ACCOUNTS, AGENTS, INITIAL_NEAR, NEAR, connect, deploymentFor, env, fail, formatNear,
  newKey, publicKeyOf, requireEnv, requireTestnet, setEnv, writeDeployments,
} from "./lib/near.mjs";

/** Rough NEAR the whole setup + deploy needs: sub-accounts + code storage for core and tusdc. */
const NEEDED_NEAR = 20n * NEAR;

const JUDGE_METHODS = ["submit_verdict", "settle"];
const AGENT_METHODS = ["register_agent", "accept_job", "deliver"];
const JUDGE_ALLOWANCE = 1n * NEAR; // gas budget of the restricted key
const AGENT_ALLOWANCE = NEAR / 4n;

async function main() {
  const { parent: parentId, rpcUrl } = requireTestnet();
  const chain = connect(rpcUrl);
  const parent = chain.account(parentId, requireEnv("NEAR_PARENT_PRIVATE_KEY"));

  console.log(`\nSurety testnet setup\n  parent: ${parentId}\n  rpc:    ${rpcUrl}\n`);
  const state = await parent.getState();
  console.log(`  parent balance: ${formatNear(state.balance.available)} NEAR available`);
  if (state.balance.available < NEEDED_NEAR) {
    console.warn(`  ⚠ setup + deploy need about ${formatNear(NEEDED_NEAR)} NEAR. Top up from a testnet faucet first.`);
  }

  // 1. Sub-accounts
  console.log("\n1. Sub-accounts");
  for (const [prefix, keyVar] of Object.entries(ACCOUNTS)) {
    const id = `${prefix}.${parentId}`;
    const exists = await chain.exists(id);
    const secret = env(keyVar);
    if (exists) {
      if (!secret) fail(`${id} already exists but ${keyVar} is not in .env. Put its key there, or delete the account, then re-run.`);
      const keys = await chain.account(id).getAccessKeyList();
      if (!keys.keys.some((k) => k.public_key === publicKeyOf(secret))) fail(`${keyVar} in .env is not a key of ${id}.`);
      console.log(`  ✓ ${id} (exists)`);
      continue;
    }
    const k = secret ? { secret, publicKey: publicKeyOf(secret) } : newKey();
    setEnv({ [keyVar]: k.secret }); // save first, create second
    const nearToTransfer = INITIAL_NEAR[prefix] ?? INITIAL_NEAR.default;
    await parent.createSubAccount({ accountOrPrefix: id, publicKey: k.publicKey, nearToTransfer });
    console.log(`  + ${id} created with ${formatNear(nearToTransfer)} NEAR`);
  }

  // 2. Restricted function-call keys
  console.log("\n2. Function-call keys");
  const coreId = `core.${parentId}`;
  const restricted = [
    { owner: "judge", keyVar: "JUDGE_PRIVATE_KEY", methods: JUDGE_METHODS, allowance: JUDGE_ALLOWANCE },
    ...AGENTS.map((a) => ({
      owner: a,
      keyVar: `${a.toUpperCase().replace(/-/g, "_")}_FC_PRIVATE_KEY`,
      methods: AGENT_METHODS,
      allowance: AGENT_ALLOWANCE,
    })),
  ];
  for (const r of restricted) {
    const id = `${r.owner}.${parentId}`;
    const owner = chain.account(id, requireEnv(ACCOUNTS[r.owner]));
    const onChain = (await owner.getAccessKeyList()).keys;
    const current = env(r.keyVar);
    if (current && onChain.some((k) => k.public_key === publicKeyOf(current))) {
      console.log(`  ✓ ${id}: ${r.methods.join(", ")} (exists)`);
      continue;
    }
    const k = newKey();
    setEnv({ [r.keyVar]: k.secret });
    await owner.addFunctionCallAccessKey({ publicKey: k.publicKey, contractId: coreId, methodNames: r.methods, allowance: r.allowance });
    console.log(`  + ${id}: ${r.methods.join(", ")} on ${coreId} -> ${r.keyVar}`);
  }

  // 3. Public ids
  const dep = deploymentFor(parentId);
  setEnv({ SURETY_CONTRACT_ID: dep.contract_id, TOKEN_ID: dep.token_id, JUDGE_ACCOUNT_ID: dep.judge_id });
  writeDeployments({ ...dep, setup_at: new Date().toISOString() });
  console.log("\n3. Wrote SURETY_CONTRACT_ID, TOKEN_ID, JUDGE_ACCOUNT_ID to .env and ids to deployments/testnet.json");

  console.log("\nDone. Keys are only in .env (git-ignored). Next: npm run deploy\n");
}

main().catch((e) => fail(`setup failed: ${e?.message ?? e}`));

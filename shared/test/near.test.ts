import { test } from "node:test";
import assert from "node:assert/strict";
import { NearChain, parseEvents, type ChangeCall, type Transport } from "../src/near.ts";

function fakeTransport(logs: string[] = []) {
  const calls: ChangeCall[] = [];
  const views: { contractId: string; method: string; args: unknown }[] = [];
  const t: Transport = {
    async view<T>(contractId: string, method: string, args: Record<string, unknown>) {
      views.push({ contractId, method, args });
      if (method === "get_config") return { appeal_deposit: "5000000" } as T;
      return null as T;
    },
    async change(c) {
      calls.push(c);
      return { tx: "TX1", logs, returnValue: undefined };
    },
    async blockTimeMs() {
      return 123;
    },
  };
  return { t, calls, views };
}

test("token deposits go through ft_transfer_call on the token with 1 yocto", async () => {
  const { t, calls } = fakeTransport();
  const chain = new NearChain("core.x.testnet", "tusdc.x.testnet", t);
  await chain.as("agent.x.testnet").depositBond("100");
  await chain.as("backer.x.testnet").depositPool("agent.x.testnet", "7");
  await chain.as("client.x.testnet").appeal(3);
  assert.equal(calls.length, 3);
  for (const c of calls) {
    assert.equal(c.receiverId, "tusdc.x.testnet");
    assert.equal(c.methodName, "ft_transfer_call");
    assert.equal(c.deposit, 1n);
    assert.equal((c.args as { receiver_id: string }).receiver_id, "core.x.testnet");
  }
  assert.deepEqual(JSON.parse((calls[0]!.args as { msg: string }).msg), { action: "bond" });
  assert.deepEqual(JSON.parse((calls[1]!.args as { msg: string }).msg), { action: "pool", agent_id: "agent.x.testnet" });
  assert.deepEqual(JSON.parse((calls[2]!.args as { msg: string }).msg), { action: "appeal", job_id: 3 });
  assert.equal((calls[2]!.args as { amount: string }).amount, "5000000");
});

test("postJob reads the job id from the job_posted event", async () => {
  const ev = { standard: "surety", version: "1.0.0", event: "job_posted", data: [{ job_id: 42, client_id: "c" }] };
  const { t, calls } = fakeTransport(["some other log", `EVENT_JSON:${JSON.stringify(ev)}`]);
  const chain = new NearChain("core.x.testnet", "tusdc.x.testnet", t);
  const r = await chain.as("client.x.testnet").postJob({ value: "50", spec_hash: "a".repeat(64), spec_url: "u", deadline_ms: 9 });
  assert.equal(r.value, 42);
  assert.equal(r.tx, "TX1");
  const msg = JSON.parse((calls[0]!.args as { msg: string }).msg);
  assert.deepEqual(msg, { action: "post_job", spec_hash: "a".repeat(64), spec_url: "u", deadline_ms: 9 });
});

test("postJob fails loudly when the contract refunded the transfer", async () => {
  const { t } = fakeTransport(["refund"]);
  const chain = new NearChain("core.x.testnet", "tusdc.x.testnet", t);
  await assert.rejects(chain.as("c").postJob({ value: "1", spec_hash: "a".repeat(64), spec_url: "u", deadline_ms: 9 }), /not posted/);
});

test("contract calls use SPEC method names and argument names, no deposit", async () => {
  const { t, calls } = fakeTransport();
  const chain = new NearChain("core.x.testnet", "tusdc.x.testnet", t);
  const a = chain.as("agent.x.testnet");
  await a.registerAgent();
  await a.acceptJob(1);
  await a.deliver(1, "url", "h");
  await chain.as("judge.x.testnet").submitVerdict({ job_id: 1, score_bps: 10000, checks_passed: 7, checks_total: 7, receipts_hash: "r" });
  await chain.as("judge.x.testnet").settle(1);
  await chain.as("panel.x.testnet").resolveAppeal(1, 5000);
  await a.withdrawBond("5");
  await chain.as("backer.x.testnet").withdrawPool("agent.x.testnet", "6");
  await chain.as("client.x.testnet").cancelExpired(2);
  assert.deepEqual(
    calls.map((c) => [c.methodName, c.args, c.receiverId, c.deposit]),
    [
      ["register_agent", {}, "core.x.testnet", 0n],
      ["accept_job", { job_id: 1 }, "core.x.testnet", 0n],
      ["deliver", { job_id: 1, patch_url: "url", patch_hash: "h" }, "core.x.testnet", 0n],
      ["submit_verdict", { job_id: 1, score_bps: 10000, checks_passed: 7, checks_total: 7, receipts_hash: "r" }, "core.x.testnet", 0n],
      ["settle", { job_id: 1 }, "core.x.testnet", 0n],
      ["resolve_appeal", { job_id: 1, score_bps: 5000 }, "core.x.testnet", 0n],
      ["withdraw_bond", { amount: "5" }, "core.x.testnet", 0n],
      ["withdraw_pool", { agent_id: "agent.x.testnet", amount: "6" }, "core.x.testnet", 0n],
      ["cancel_expired", { job_id: 2 }, "core.x.testnet", 0n],
    ],
  );
  // Agent and judge actions carry no deposit, so restricted function-call keys can sign them.
  assert.ok(calls.every((c) => c.gas > 0n));
});

test("views use SPEC names", async () => {
  const { t, views } = fakeTransport();
  const chain = new NearChain("core.x.testnet", "tusdc.x.testnet", t);
  await chain.listJobsByStatus("Delivered", 10);
  await chain.getAgent("a");
  await chain.getJob(3);
  await chain.ftBalanceOf("a");
  assert.deepEqual(views, [
    { contractId: "core.x.testnet", method: "list_jobs_by_status", args: { status: "Delivered", limit: 10 } },
    { contractId: "core.x.testnet", method: "get_agent", args: { agent_id: "a" } },
    { contractId: "core.x.testnet", method: "get_job", args: { job_id: 3 } },
    { contractId: "tusdc.x.testnet", method: "ft_balance_of", args: { account_id: "a" } },
  ]);
  assert.equal(chain.explorerTxUrl("abc"), "https://testnet.nearblocks.io/txns/abc");
});

test("mainnet is refused", () => {
  assert.throws(() => new NearChain("a", "b", fakeTransport().t, "mainnet"), /testnet only/);
});

test("parseEvents ignores junk", () => {
  assert.deepEqual(parseEvents(["x", "EVENT_JSON:{bad", 'EVENT_JSON:{"event":"e","data":[]}']), [{ event: "e", data: [] }]);
});

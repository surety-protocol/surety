// CLI: npm run run-agent -w @surety/agents -- --agent honest|sloppy|cheater --job <id>
// Signs with the agent's function-call key from .env (accept_job, deliver).

import { parseArgs } from "node:util";
import { loadEnv, nearChainFromEnv, REPO_ROOT, requireEnv } from "@surety/shared/env";
import { runAgent, SCENARIOS, type AgentKind } from "./agent.ts";

const { values } = parseArgs({ options: { agent: { type: "string" }, job: { type: "string" } } });
const kind = values.agent as AgentKind;
if (!kind || !(kind in SCENARIOS) || values.job === undefined || !/^\d+$/.test(values.job)) {
  console.error("usage: run-agent --agent honest|sloppy|cheater --job <id>");
  process.exit(2);
}
loadEnv();
const chain = nearChainFromEnv();
const agentId = `${kind === "cheater" ? "cheater" : kind}-agent.${requireEnv("NEAR_PARENT")}`;
await runAgent({
  chain,
  agentId,
  jobId: Number(values.job),
  repoRoot: REPO_ROOT,
  patchRef: SCENARIOS[kind].patch,
  log: (step, detail, tx) => console.log(`${step}: ${detail ?? ""}${tx ? `  ${chain.explorerTxUrl(tx)}` : ""}`),
});

// CLI: npm run post-job -w @surety/agents -- --spec agents/jobs/login-bug.json --value 50000000 [--client <account>]

import { parseArgs } from "node:util";
import { loadEnv, nearChainFromEnv, REPO_ROOT, requireEnv } from "@surety/shared/env";
import { postJob } from "./agent.ts";

const { values } = parseArgs({ options: { spec: { type: "string" }, value: { type: "string" }, client: { type: "string" }, hours: { type: "string" } } });
if (!values.spec || !values.value || !/^\d+$/.test(values.value)) {
  console.error("usage: post-job --spec <repo path> --value <token units> [--client <account>] [--hours 24]");
  process.exit(2);
}
loadEnv();
const chain = nearChainFromEnv();
const id = await postJob({
  chain,
  clientId: values.client ?? `client.${requireEnv("NEAR_PARENT")}`,
  repoRoot: REPO_ROOT,
  specRef: values.spec,
  value: values.value,
  deadlineMs: (await chain.now()) + Number(values.hours ?? 24) * 3_600_000,
  log: (step, detail, tx) => console.log(`${step}: ${detail ?? ""}${tx ? `  ${chain.explorerTxUrl(tx)}` : ""}`),
});
console.log(id);

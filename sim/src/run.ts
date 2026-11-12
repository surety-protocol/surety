// npm run sim: runs the market simulation (MECHANISM.md section 7) and writes
//   sim/out/results.csv   one row per settled job
//   sim/out/agents.json   final state of every agent
//   sim/out/rounds.json   per-round snapshot (for charts)
//   sim/out/summary.json  the four findings
// summary.json and rounds.json are also copied to web/public/sim/ for the dashboard.
// Findings are reported as they come out. We never tune the run to make one hold.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSimulation } from "./model.ts";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "out");
const WEB = join(here, "..", "..", "web", "public", "sim");

const r = await runSimulation();

const cols = ["round", "job_id", "kind", "client_id", "agent_id", "value", "premium_bps", "score_bps", "outcome", "to_agent", "to_client", "to_pool", "from_bond", "from_pool"] as const;
const csv = [cols.join(","), ...r.jobs.map((j) => cols.map((c) => String(j[c])).join(","))].join("\n") + "\n";
const summary = { generated_at: new Date().toISOString(), config: r.config, agents: r.agents, findings: r.findings };

mkdirSync(OUT, { recursive: true });
mkdirSync(WEB, { recursive: true });
writeFileSync(join(OUT, "results.csv"), csv);
writeFileSync(join(OUT, "agents.json"), JSON.stringify(r.agents, null, 2) + "\n");
for (const dir of [OUT, WEB]) {
  writeFileSync(join(dir, "rounds.json"), JSON.stringify(r.rounds) + "\n");
  writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
}

console.log(`${r.config.market_jobs} market jobs, ${r.config.sock_puppet_jobs} sock-puppet jobs, ${r.config.collusion_jobs} colluding jobs (seed ${r.config.seed})\n`);
for (const f of r.findings) {
  console.log(`[${f.holds ? "holds" : "DOES NOT HOLD"}] ${f.headline}`);
  console.log(`  ${f.explanation}`);
  console.log(`  ${f.numbers}\n`);
}
console.log(`Wrote ${OUT} and ${WEB}`);

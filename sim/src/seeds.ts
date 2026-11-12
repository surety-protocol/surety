// npm run sim:seeds [-- <count>]
//
// Robustness check: runs the simulation over many seeds, once with the current
// rules and under each experiment: A (premium of an agent without backers goes
// to a protocol reserve instead of its own bond), B (repeat clients count
// value/k^2 instead of value/k), and both. It reports how often each
// finding holds plus the numbers behind it. Writes sim/out/seeds.json.
// The finding tests are the same as in model.ts; nothing is tuned per run.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSimulation, type SimResult } from "./model.ts";

const count = Number(process.argv[2] ?? 50);
const FIRST_SEED = 1;
// Current rules, option A (fee to reserve), option B (value/k^2), and both.
const variants = {
  current: { premiumWithoutBackers: "bond", repeatClientWeight: "value/k" },
  "A:reserve": { premiumWithoutBackers: "reserve", repeatClientWeight: "value/k" },
  "B:value/k2": { premiumWithoutBackers: "bond", repeatClientWeight: "value/k2" },
  "A+B": { premiumWithoutBackers: "reserve", repeatClientWeight: "value/k2" },
} as const;
const names = Object.keys(variants) as (keyof typeof variants)[];

interface RunMetrics {
  seed: number;
  holds: Record<string, boolean>;
  cheater_premium_bps: number;
  peer_avg_premium_bps: number;
  cheater_measured_failure_bps: number;
  /** Share of last-quarter market jobs won by honest agents above 40% true failure. */
  bad_late_share: number;
  collusion_profit_tusdc: number;
  median_honest_bond_tusdc: number;
}

function metrics(seed: number, r: SimResult): RunMetrics {
  const honest = r.agents.filter((a) => a.role === "honest");
  const cheater = r.agents.find((a) => a.role === "cheater")!;
  const peers = honest.filter((a) => Math.abs(a.true_failure_bps - cheater.true_failure_bps) <= 500);
  const lastQuarter = r.config.rounds - Math.max(1, Math.floor(r.config.rounds / 4)) + 1;
  const lateTotal = r.jobs.filter((j) => j.kind === "market" && j.round >= lastQuarter).length;
  const badLate = honest.filter((a) => a.true_failure_bps > 4000).reduce((s, a) => s + a.jobs_last_quarter, 0);
  const collusion = r.jobs
    .filter((j) => j.kind === "collusion")
    .reduce((s, j) => s + BigInt(j.to_client) - BigInt(j.value) - BigInt(j.from_bond), 0n);
  const bonds = honest.map((a) => Number(BigInt(a.bond) / 10_000n) / 100).sort((a, b) => a - b);
  return {
    seed,
    holds: Object.fromEntries(r.findings.map((f) => [f.id, f.holds])),
    cheater_premium_bps: cheater.premium_bps,
    peer_avg_premium_bps: peers.length ? Math.round(peers.reduce((s, a) => s + a.premium_bps, 0) / peers.length) : 0,
    cheater_measured_failure_bps: cheater.failure_rate_bps,
    bad_late_share: lateTotal ? badLate / lateTotal : 0,
    collusion_profit_tusdc: Number(collusion) / 1e6,
    median_honest_bond_tusdc: bonds[Math.floor(bonds.length / 2)]!,
  };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

const out: Record<string, { runs: RunMetrics[]; summary: Record<string, unknown> }> = {};
for (const v of names) {
  const runs: RunMetrics[] = [];
  for (let seed = FIRST_SEED; seed < FIRST_SEED + count; seed++) {
    runs.push(metrics(seed, await runSimulation({ seed, ...variants[v] })));
  }
  const ids = Object.keys(runs[0]!.holds);
  out[v] = {
    runs,
    summary: {
      seeds: count,
      holds: Object.fromEntries(ids.map((id) => [id, runs.filter((r) => r.holds[id]).length])),
      median_cheater_premium_bps: median(runs.map((r) => r.cheater_premium_bps)),
      median_peer_premium_bps: median(runs.map((r) => r.peer_avg_premium_bps)),
      median_cheater_measured_failure_bps: median(runs.map((r) => r.cheater_measured_failure_bps)),
      median_bad_late_share: median(runs.map((r) => r.bad_late_share)),
      median_collusion_profit_tusdc: median(runs.map((r) => r.collusion_profit_tusdc)),
      median_honest_bond_tusdc: median(runs.map((r) => r.median_honest_bond_tusdc)),
    },
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "..", "out");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "seeds.json"), JSON.stringify(out, null, 2) + "\n");

const ids = Object.keys(out.current!.runs[0]!.holds);
console.log(`Seeds ${FIRST_SEED}..${FIRST_SEED + count - 1}. Times each finding holds:\n`);
console.log(["finding".padEnd(26), ...names.map((v) => v.padStart(12))].join(""));
for (const id of ids) {
  console.log([id.padEnd(26), ...names.map((v) => `${(out[v]!.summary.holds as Record<string, number>)[id]}/${count}`.padStart(12))].join(""));
}
console.log("\nMedians:");
for (const k of Object.keys(out.current!.summary).filter((k) => k.startsWith("median"))) {
  console.log([k.padEnd(38), ...names.map((v) => String(out[v]!.summary[k]).padStart(12))].join(""));
}
console.log(`\nWrote ${join(dir, "seeds.json")}`);

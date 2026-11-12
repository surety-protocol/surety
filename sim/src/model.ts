// Market simulation for MECHANISM.md section 7.
//
// Every job runs through MockChain from @surety/shared, which applies the same
// rules as the contract (pricing, job weight value/k, coverage and leverage caps,
// settlement, pool gains and losses). Nothing here re-implements a formula.
// Fixed seed, no network, no AI calls: the judge's verdict is drawn from each
// agent's hidden true failure rate.

import { sha256Hex } from "@surety/shared/hash";
import { MockChain } from "@surety/shared/mock-chain";
import { canAccept } from "@surety/shared/pricing";
import type { AgentView, JobView } from "@surety/shared/types";

export const UNIT = 1_000_000n; // tUSDC has 6 decimals

export interface SimOptions {
  seed?: number;
  rounds?: number;
  jobsPerRound?: number;
}

export type Role = "honest" | "cheater" | "colluder";

export interface AgentSnapshot {
  agent_id: string;
  premium_bps: number;
  failure_rate_bps: number;
  bond: string;
  pool_total: string;
  jobs_won: number;
}

export interface RoundSnapshot {
  round: number;
  jobs_done: number;
  agents: AgentSnapshot[];
  /** Colluding agent + partner client: wallets + bond, in token units. */
  pair_money: string;
  /** Cheater + its sock-puppet clients: wallets + bond, in token units. */
  cheater_money: string;
}

export interface JobRow {
  round: number;
  job_id: number;
  kind: "market" | "sock_puppet" | "collusion";
  client_id: string;
  agent_id: string;
  value: string;
  premium_bps: number;
  score_bps: number;
  outcome: string;
  to_agent: string;
  to_client: string;
  to_pool: string;
  from_bond: string;
  from_pool: string;
}

export interface AgentResult {
  agent_id: string;
  role: Role;
  true_failure_bps: number;
  failure_rate_bps: number;
  premium_bps: number;
  bond: string;
  pool_total: string;
  market_jobs: number;
  jobs_last_quarter: number;
  can_take_jobs: boolean;
}

export interface Finding {
  id: "failure_rate_converges" | "bad_agents_drop_out" | "cheater_stays_expensive" | "collusion_loses_money";
  holds: boolean;
  headline: string;
  explanation: string;
  numbers: string;
}

export interface SimResult {
  config: { seed: number; rounds: number; market_jobs: number; sock_puppet_jobs: number; collusion_jobs: number };
  agents: AgentResult[];
  rounds: RoundSnapshot[];
  jobs: JobRow[];
  findings: Finding[];
}

/** Mulberry32: small, fast, deterministic. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let z = Math.imul(s ^ (s >>> 15), 1 | s);
    z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z;
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

const tusdc = (n: number) => BigInt(n) * UNIT;
const pad = (n: number) => String(n).padStart(2, "0");

export async function runSimulation(opts: SimOptions = {}): Promise<SimResult> {
  const seed = opts.seed ?? 20261114;
  const rounds = opts.rounds ?? 20;
  const jobsPerRound = opts.jobsPerRound ?? 25;
  const rand = rng(seed);

  const chain = new MockChain({ judgeId: "judge.sim", panelId: "panel.sim" });
  const cfg = chain.config;
  const judge = chain.as(chain.judgeId);

  // ---- populations ----
  const trueRate = new Map<string, number>(); // hidden failure probability per agent
  const role = new Map<string, Role>();
  const honest: string[] = [];
  for (let i = 0; i < 19; i++) {
    const id = `honest${pad(i + 1)}.sim`;
    honest.push(id);
    trueRate.set(id, 0.02 + (0.58 * i) / 18); // 2% .. 60%
    role.set(id, "honest");
  }
  const cheater = "cheater.sim";
  trueRate.set(cheater, 0.3);
  role.set(cheater, "cheater");
  const socks = ["sock1.sim", "sock2.sim", "sock3.sim"];
  const colluder = "colluder.sim";
  trueRate.set(colluder, 0.05); // honest-looking on market jobs, fails on purpose for its partner
  role.set(colluder, "colluder");
  const partner = "partner.sim";
  const clients = Array.from({ length: 60 }, (_, i) => `client${pad(i + 1)}.sim`);
  const backers = Array.from({ length: 10 }, (_, i) => `backer${pad(i + 1)}.sim`);
  const agents = [...honest, cheater, colluder];

  const START_BOND = 300;
  for (const a of agents) {
    chain.mint(a, String(tusdc(START_BOND)));
    await chain.as(a).registerAgent();
    await chain.as(a).depositBond(String(tusdc(START_BOND)));
  }
  for (const c of clients) chain.mint(c, String(tusdc(100_000)));
  for (const s of socks) chain.mint(s, String(tusdc(2_000)));
  chain.mint(partner, String(tusdc(2_000)));
  for (const b of backers) chain.mint(b, String(tusdc(1_000)));

  const money = (ids: string[], bonds: string[]) => {
    let total = 0n;
    for (const id of ids) total += chain.balanceOf(id);
    for (const id of bonds) total += BigInt(agentCache.get(id)?.bond ?? "0");
    return total;
  };
  const agentCache = new Map<string, AgentView>();
  const refresh = async () => {
    for (const a of agents) agentCache.set(a, (await chain.getAgent(a))!);
  };
  await refresh();
  const pairStart = money([colluder, partner], [colluder]);

  const jobs: JobRow[] = [];
  const snapshots: RoundSnapshot[] = [];
  const marketJobsBy = new Map<string, number[]>(agents.map((a) => [a, []])); // round of each market job
  const backedAgent = new Map<string, string>(); // backer -> agent
  let lastRoundIncome = new Map<string, bigint>(); // what a pool on this agent would have earned last round
  let jobCounter = 0;
  let marketJobs = 0;

  const fits = (a: AgentView, value: bigint) =>
    canAccept({
      bond: BigInt(a.bond),
      poolTotal: BigInt(a.pool_total),
      openExposure: BigInt(a.open_exposure),
      value,
      config: { min_bond: BigInt(cfg.min_bond), max_leverage: cfg.max_leverage },
    }).ok;

  const post = async (client: string, value: bigint) => {
    const n = ++jobCounter;
    const r = await chain.as(client).postJob({
      value: String(value),
      spec_hash: sha256Hex(`sim-spec-${n}`),
      spec_url: `sim://spec/${n}`,
      deadline_ms: (await chain.now()) + 86_400_000,
    });
    return r.value;
  };

  for (let round = 1; round <= rounds; round++) {
    // 1. Backers move money toward the agent whose pool would have earned most last round.
    if (round > 1) {
      chain.advance(cfg.withdraw_cooldown_ms + 1); // cooldown runs from the agent's last settlement
      for (const [b, a] of backedAgent) {
        const view = (await chain.getAgent(a))!;
        const mine = view.backers.find((x) => x.backer_id === b);
        if (mine && BigInt(mine.amount) > 0n) await chain.as(b).withdrawPool(a, mine.amount);
        backedAgent.delete(b);
      }
      await refresh();
      const ranked = agents
        .filter((a) => BigInt(agentCache.get(a)!.bond) >= BigInt(cfg.min_bond))
        .sort((x, y) => {
          const d = (lastRoundIncome.get(y) ?? 0n) - (lastRoundIncome.get(x) ?? 0n);
          return d === 0n ? (x < y ? -1 : 1) : d > 0n ? 1 : -1;
        })
        .filter((a) => (lastRoundIncome.get(a) ?? 0n) > 0n);
      for (let i = 0; i < backers.length && ranked.length; i++) {
        const b = backers[i]!;
        const target = ranked[i % Math.min(3, ranked.length)]!;
        const bal = chain.balanceOf(b);
        if (bal > 0n) {
          await chain.as(b).depositPool(target, String(bal));
          backedAgent.set(b, target);
        }
      }
      await refresh();
    }

    const open: { id: number; kind: JobRow["kind"]; agent: string; client: string; score: number }[] = [];
    // 2. Colluding pair, posted first so the colluder has room. After building a
    //    record for 5 rounds, the partner posts the
    //    biggest jobs the colluder can take and the colluder fails them on purpose.
    if (round > 5) {
      for (let k = 0; k < 2; k++) {
        const value = tusdc(100);
        if (!fits(agentCache.get(colluder)!, value) || chain.balanceOf(partner) < value) break;
        const id = await post(partner, value);
        await chain.as(colluder).acceptJob(id);
        agentCache.set(colluder, (await chain.getAgent(colluder))!);
        open.push({ id, kind: "collusion", agent: colluder, client: partner, score: 0 });
      }
    }

    // 3. Market jobs: each client picks the cheapest agent with enough coverage.
    for (let j = 0; j < jobsPerRound; j++) {
      const client = clients[Math.floor(rand() * clients.length)]!;
      const value = tusdc(20 + Math.floor(rand() * 81)); // 20..100 tUSDC
      const eligible = agents.filter((a) => fits(agentCache.get(a)!, value));
      if (!eligible.length) continue;
      const shuffled = eligible.map((a) => ({ a, t: rand() }));
      shuffled.sort((x, y) => agentCache.get(x.a)!.premium_bps - agentCache.get(y.a)!.premium_bps || x.t - y.t);
      const agent = shuffled[0]!.a;
      const id = await post(client, value);
      await chain.as(agent).acceptJob(id);
      agentCache.set(agent, (await chain.getAgent(agent))!);
      const failed = rand() < trueRate.get(agent)!;
      open.push({ id, kind: "market", agent, client, score: failed ? 0 : 10_000 });
      marketJobsBy.get(agent)!.push(round);
      marketJobs++;
    }

    // 4. Cheater: each sock puppet hires the cheater for an easy job it always passes.
    for (const s of socks) {
      const value = tusdc(50);
      if (!fits(agentCache.get(cheater)!, value)) continue;
      const id = await post(s, value);
      await chain.as(cheater).acceptJob(id);
      agentCache.set(cheater, (await chain.getAgent(cheater))!);
      open.push({ id, kind: "sock_puppet", agent: cheater, client: s, score: 10_000 });
    }

    // 5. Deliver, judge, wait out the appeal window, settle.
    for (const o of open) {
      await chain.as(o.agent).deliver(o.id, `sim://patch/${o.id}`, sha256Hex(`sim-patch-${o.id}`));
      await judge.submitVerdict({
        job_id: o.id,
        score_bps: o.score,
        checks_passed: o.score === 10_000 ? 7 : 0,
        checks_total: 7,
        receipts_hash: sha256Hex(`sim-receipt-${o.id}`),
      });
    }
    chain.advance(cfg.appeal_window_ms + cfg.withdraw_cooldown_ms + 1);
    const income = new Map<string, bigint>();
    for (const o of open) {
      await judge.settle(o.id);
      const v = (await chain.getJob(o.id)) as JobView;
      const s = v.settlement!;
      jobs.push({
        round,
        job_id: o.id,
        kind: o.kind,
        client_id: o.client,
        agent_id: o.agent,
        value: v.value,
        premium_bps: v.premium_bps ?? 0,
        score_bps: o.score,
        outcome: s.outcome,
        to_agent: s.to_agent,
        to_client: s.to_client,
        to_pool: s.to_pool,
        from_bond: s.from_bond,
        from_pool: s.from_pool,
      });
      // What a pool on this agent earns (or would have earned) from this job.
      const value = BigInt(v.value);
      let earned: bigint;
      if (s.outcome === "Fail") {
        const collected = BigInt(s.from_bond) + BigInt(s.from_pool);
        earned = collected - (collected * BigInt(cfg.client_share_bps)) / 10_000n - BigInt(s.from_pool);
      } else {
        earned = value - BigInt(s.to_client) - BigInt(s.to_agent); // the premium
      }
      income.set(o.agent, (income.get(o.agent) ?? 0n) + earned);
    }
    lastRoundIncome = income;
    await refresh();

    snapshots.push({
      round,
      jobs_done: marketJobs,
      agents: agents.map((a) => {
        const v = agentCache.get(a)!;
        return {
          agent_id: a,
          premium_bps: v.premium_bps,
          failure_rate_bps: v.failure_rate_bps,
          bond: v.bond,
          pool_total: v.pool_total,
          jobs_won: marketJobsBy.get(a)!.filter((r) => r === round).length,
        };
      }),
      pair_money: String(money([colluder, partner], [colluder])),
      cheater_money: String(money([cheater, ...socks], [cheater])),
    });
  }

  chain.checkInvariant();

  // ---- results ----
  const lastQuarter = rounds - Math.max(1, Math.floor(rounds / 4)) + 1;
  const results: AgentResult[] = agents.map((a) => {
    const v = agentCache.get(a)!;
    const won = marketJobsBy.get(a)!;
    return {
      agent_id: a,
      role: role.get(a)!,
      true_failure_bps: Math.round(trueRate.get(a)! * 10_000),
      failure_rate_bps: v.failure_rate_bps,
      premium_bps: v.premium_bps,
      bond: v.bond,
      pool_total: v.pool_total,
      market_jobs: won.length,
      jobs_last_quarter: won.filter((r) => r >= lastQuarter).length,
      can_take_jobs: BigInt(v.bond) >= BigInt(cfg.min_bond),
    };
  });

  const findings = computeFindings(results, {
    pairStart,
    pairEnd: money([colluder, partner], [colluder]),
    collusionJobs: jobs.filter((j) => j.kind === "collusion"),
    priorBps: Number((BigInt(cfg.reference_value) * 10_000n) / (5n * BigInt(cfg.reference_value))),
    lastQuarter,
    rounds,
  });

  return {
    config: {
      seed,
      rounds,
      market_jobs: marketJobs,
      sock_puppet_jobs: jobs.filter((j) => j.kind === "sock_puppet").length,
      collusion_jobs: jobs.filter((j) => j.kind === "collusion").length,
    },
    agents: results,
    rounds: snapshots,
    jobs,
    findings,
  };
}

const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;
const tok = (units: bigint) => `${(Number(units) / 1e6).toFixed(2)} tUSDC`;

function computeFindings(
  agents: AgentResult[],
  x: { pairStart: bigint; pairEnd: bigint; collusionJobs: JobRow[]; priorBps: number; lastQuarter: number; rounds: number },
): Finding[] {
  const honest = agents.filter((a) => a.role === "honest");

  // 1. Every honest agent with a real record (10+ jobs) ends closer to its true
  //    rate than the 20% prior every agent starts from.
  const tested = honest.filter((a) => a.market_jobs >= 10);
  const converged = tested.filter((a) => Math.abs(a.failure_rate_bps - a.true_failure_bps) < Math.abs(x.priorBps - a.true_failure_bps));
  const f1 = tested.length > 0 && converged.length === tested.length;

  // 2. Honest agents above 40% true failure either lost their bond or won no jobs late on.
  const bad = honest.filter((a) => a.true_failure_bps > 4000);
  const out = bad.filter((a) => !a.can_take_jobs || a.jobs_last_quarter === 0);
  const f2 = bad.length > 0 && out.length === bad.length;

  // 3. The cheater (30% true rate) is priced no cheaper than honest agents with 25-35%.
  const cheater = agents.find((a) => a.role === "cheater")!;
  const peers = honest.filter((a) => Math.abs(a.true_failure_bps - cheater.true_failure_bps) <= 500);
  const peerAvg = peers.length ? Math.round(peers.reduce((s, a) => s + a.premium_bps, 0) / peers.length) : 0;
  const f3 = peers.length > 0 && cheater.premium_bps >= peerAvg;

  // 4. Collusion profit, counted on the colluding jobs only (the colluder's honest
  //    market income is left out so it cannot hide a loss): what the partner got
  //    back above its escrow, minus what the colluder's bond paid.
  const net = x.collusionJobs.reduce((s, j) => s + BigInt(j.to_client) - BigInt(j.value) - BigInt(j.from_bond), 0n);
  const f4 = x.collusionJobs.length > 0 && net < 0n;
  const drained = x.collusionJobs.reduce((s, j) => s + BigInt(j.from_pool), 0n);

  return [
    {
      id: "failure_rate_converges",
      holds: f1,
      headline: "Each honest agent's failure rate moves toward its true rate",
      explanation: `Every agent starts at the ${pct(x.priorBps)} prior. Of the ${tested.length} honest agents with 10+ jobs, ${converged.length} ended closer to their true rate than the prior.`,
      numbers: tested.map((a) => `${a.agent_id}: true ${pct(a.true_failure_bps)}, measured ${pct(a.failure_rate_bps)} (${a.market_jobs} jobs)`).join("; "),
    },
    {
      id: "bad_agents_drop_out",
      holds: f2,
      headline: "Agents above 40% failure lose their bond or stop winning jobs",
      explanation: `${out.length} of ${bad.length} agents above 40% either fell below the minimum bond or won no jobs in rounds ${x.lastQuarter}-${x.rounds}.`,
      numbers: bad.map((a) => `${a.agent_id} (${pct(a.true_failure_bps)}): bond ${tok(BigInt(a.bond))}, ${a.jobs_last_quarter} late jobs`).join("; "),
    },
    {
      id: "cheater_stays_expensive",
      holds: f3,
      headline: "The cheater's price stays above honest agents of the same skill",
      explanation: f3
        ? "Self-dealt jobs from sock puppets count value/k, so they barely improve the cheater's record."
        : "Sock-puppet jobs lowered the cheater's price below its honest peers. Known weakness: value/k weighting limits but does not remove self-dealing.",
      numbers: `cheater premium ${pct(cheater.premium_bps)} (measured failure ${pct(cheater.failure_rate_bps)}); honest peers 25-35% average ${pct(peerAvg)} (${peers.map((p) => p.agent_id).join(", ")})`,
    },
    {
      id: "collusion_loses_money",
      holds: f4,
      headline: "The colluding pair ends with less money than it started with",
      explanation: `The partner's refunds come out of the colluder's own bond, and with backers present half of each penalty goes to the pool. Pool money drained by collusion: ${tok(drained)}.`,
      numbers: `collusion profit ${tok(net)} over ${x.collusionJobs.length} colluding jobs; pair money incl. honest work: start ${tok(x.pairStart)}, end ${tok(x.pairEnd)}`,
    },
  ];
}

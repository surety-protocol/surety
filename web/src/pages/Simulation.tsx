/**
 * Simulation page: the four findings from MECHANISM.md section 7, read from
 * /sim/summary.json and /sim/rounds.json (written by `npm run sim`, which runs
 * every job through the shared MockChain). Findings are shown as they came out,
 * including the ones that do not hold.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, BarChart2, Scale, ShieldCheck, TrendingDown } from 'lucide-react';
import {
  Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Card } from '../components/Card';

type Finding = { id: string; holds: boolean; headline: string; explanation: string; numbers: string };
type SimAgent = {
  agent_id: string;
  role: 'honest' | 'cheater' | 'colluder';
  true_failure_bps: number;
  failure_rate_bps: number;
  premium_bps: number;
  bond: string;
  market_jobs: number;
};
type Summary = {
  generated_at: string;
  config: { seed: number; rounds: number; market_jobs: number; sock_puppet_jobs: number; collusion_jobs: number };
  agents: SimAgent[];
  findings: Finding[];
};
type Round = {
  round: number;
  agents: { agent_id: string; premium_bps: number; bond: string; jobs_won: number }[];
  pair_money: string;
};

const ICONS: Record<string, { icon: React.ElementType; color: string }> = {
  failure_rate_converges: { icon: BarChart2, color: 'bg-violet-50 text-violet-600' },
  bad_agents_drop_out: { icon: TrendingDown, color: 'bg-red-50 text-red-600' },
  cheater_stays_expensive: { icon: ShieldCheck, color: 'bg-amber-50 text-amber-600' },
  collusion_loses_money: { icon: Scale, color: 'bg-blue-50 text-blue-600' },
};

const short = (id: string) => id.replace('.sim', '');
const tok = (units: string) => Number(BigInt(units) / 10_000n) / 100;
const COLORS = ['#2563eb', '#16a34a', '#f59e0b', '#dc2626', '#7c3aed', '#0891b2', '#db2777'];

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <h3 className="mb-3 text-sm font-semibold text-gray-900">{title}</h3>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">{children as React.ReactElement}</ResponsiveContainer>
      </div>
    </Card>
  );
}

export function Simulation() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [rounds, setRounds] = useState<Round[]>([]);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    Promise.all([fetch('/sim/summary.json'), fetch('/sim/rounds.json')])
      .then(async ([s, r]) => {
        if (!s.ok || !r.ok) throw new Error('missing');
        setSummary((await s.json()) as Summary);
        setRounds((await r.json()) as Round[]);
      })
      .catch(() => setMissing(true));
  }, []);

  const honest = summary?.agents.filter((a) => a.role === 'honest' && a.market_jobs > 0) ?? [];
  const rateData = honest.map((a) => ({
    agent: short(a.agent_id),
    true: a.true_failure_bps / 100,
    measured: a.failure_rate_bps / 100,
  }));

  const cheater = summary?.agents.find((a) => a.role === 'cheater');
  const peers = summary?.agents.filter((a) => a.role === 'honest' && cheater && Math.abs(a.true_failure_bps - cheater.true_failure_bps) <= 500) ?? [];
  const priceIds = [...(cheater ? [cheater.agent_id] : []), ...peers.map((p) => p.agent_id)];
  const bad = summary?.agents.filter((a) => a.role === 'honest' && a.true_failure_bps > 4000).map((a) => a.agent_id) ?? [];

  const series = (ids: string[], pick: (x: Round['agents'][number]) => number) =>
    rounds.map((r) => {
      const row: Record<string, number> = { round: r.round };
      for (const id of ids) {
        const a = r.agents.find((x) => x.agent_id === id);
        if (a) row[short(id)] = pick(a);
      }
      return row;
    });

  const jobsWonByBad = rounds.map((r) => ({
    round: r.round,
    'jobs won by >40% agents': r.agents.filter((a) => bad.includes(a.agent_id)).reduce((s, a) => s + a.jobs_won, 0),
  }));
  const pair = rounds.map((r) => ({ round: r.round, 'colluding pair (tUSDC)': tok(r.pair_money) }));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Simulation</h1>
        <p className="mt-0.5 text-sm text-gray-500">
          {summary
            ? `${summary.config.market_jobs} market jobs over ${summary.config.rounds} rounds, plus ${summary.config.sock_puppet_jobs} sock-puppet and ${summary.config.collusion_jobs} colluding jobs. Seed ${summary.config.seed}.`
            : '500 jobs, fixed seed, no network or AI calls.'}{' '}
          Every job runs through the same rules as the contract.
        </p>
        {missing && (
          <div className="mt-3 inline-flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700 ring-1 ring-amber-200 ring-inset">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            No simulation output yet. Run <code className="font-mono bg-amber-100 rounded px-1">npm run sim</code>.
          </div>
        )}
      </div>

      {summary && (
        <section aria-label="Simulation findings">
          <h2 className="mb-4 text-sm font-semibold text-gray-900">Findings</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {summary.findings.map((f) => {
              const { icon: Icon, color } = ICONS[f.id] ?? { icon: BarChart2, color: 'bg-gray-50 text-gray-600' };
              return (
                <Card key={f.id} className="flex gap-4">
                  <span className={`mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${color}`}>
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <h3 className="text-sm font-semibold text-gray-900">{f.headline}</h3>
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${
                          f.holds ? 'bg-green-50 text-green-700 ring-green-200' : 'bg-red-50 text-red-700 ring-red-200'
                        }`}
                      >
                        {f.holds ? '✓ holds' : '✗ does not hold'}
                      </span>
                    </div>
                    <p className="text-sm text-gray-600 leading-relaxed">{f.explanation}</p>
                    <p className="mt-1.5 text-xs text-gray-400 font-mono break-words">{f.numbers}</p>
                  </div>
                </Card>
              );
            })}
          </div>
        </section>
      )}

      {summary && rounds.length > 0 && (
        <section aria-label="Simulation charts" className="grid gap-4 lg:grid-cols-2">
          <ChartCard title="1. True vs measured failure rate (honest agents that got jobs, %)">
            <BarChart data={rateData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="agent" tick={{ fontSize: 10 }} interval={0} angle={-40} textAnchor="end" height={50} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend />
              <Bar dataKey="true" fill="#94a3b8" />
              <Bar dataKey="measured" fill="#2563eb" />
            </BarChart>
          </ChartCard>

          <ChartCard title="2. Jobs won per round by agents above 40% true failure">
            <BarChart data={jobsWonByBad}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="round" tick={{ fontSize: 11 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="jobs won by >40% agents" fill="#dc2626" />
            </BarChart>
          </ChartCard>

          <ChartCard title="3. Premium per round: cheater vs honest agents of the same skill (bps)">
            <LineChart data={series(priceIds, (a) => a.premium_bps)}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="round" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend />
              {priceIds.map((id, i) => (
                <Line key={id} type="monotone" dataKey={short(id)} stroke={COLORS[i % COLORS.length]} dot={false}
                  strokeWidth={id === cheater?.agent_id ? 3 : 1.5} />
              ))}
            </LineChart>
          </ChartCard>

          <ChartCard title="4. Colluding pair's money per round (wallets + bond, includes honest work)">
            <LineChart data={pair}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="round" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Line type="monotone" dataKey="colluding pair (tUSDC)" stroke="#7c3aed" dot={false} strokeWidth={2} />
            </LineChart>
          </ChartCard>
        </section>
      )}

      <Card className="bg-slate-50 border-slate-200">
        <h2 className="mb-3 text-sm font-semibold text-gray-900">How the simulation works</h2>
        <ul className="space-y-1.5 text-sm text-gray-600">
          <li>— Every job is posted, accepted, judged and settled on MockChain, the shared copy of the contract rules.</li>
          <li>— 19 honest agents with hidden failure rates from 2% to 60%, one cheater (30%) with 3 sock-puppet clients, one colluding agent + client pair, 60 clients, 10 backers.</li>
          <li>— Clients pick the cheapest agent with enough coverage. Backers move money each round toward the agent whose pool earned most.</li>
          <li>— Fixed seed, no network, no AI calls. The judge's score is drawn from each agent's true failure rate.</li>
          <li>— Output: <code className="font-mono bg-slate-100 rounded px-1">sim/out/results.csv</code>, <code className="font-mono bg-slate-100 rounded px-1">agents.json</code>, <code className="font-mono bg-slate-100 rounded px-1">rounds.json</code>, <code className="font-mono bg-slate-100 rounded px-1">summary.json</code>.</li>
        </ul>
      </Card>
    </div>
  );
}

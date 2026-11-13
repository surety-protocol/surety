import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { TrendingDown, TrendingUp, Shield, ArrowUpRight } from 'lucide-react';
import { fetchAgents } from '../lib/rpc';
import { formatUSDC, formatBps, timeAgo } from '../lib/format';
import { Spinner } from '../components/Spinner';
import type { AgentWithHistory as AgentView, PricePoint } from '../shared/types';

function Sparkline({ data }: { data: PricePoint[] }) {
  if (!data || data.length < 2) return <span className="text-xs text-slate-400">—</span>;
  const points = data.map((p) => ({ v: +(p.premium_bps / 100).toFixed(2) }));
  const trend = points[points.length - 1].v - points[0].v;
  const stroke = trend <= 0 ? '#16a34a' : '#dc2626';
  return (
    <div style={{ width: 80, height: 32 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points}>
          <Line type="monotone" dataKey="v" stroke={stroke} dot={false} strokeWidth={1.5} />
          <YAxis hide domain={['auto', 'auto']} />
          <XAxis dataKey="v" hide />
          <Tooltip formatter={(v: number) => [`${v}%`, 'Premium']} contentStyle={{ fontSize: 11 }} labelFormatter={() => ''} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function RecordBar({ agent }: { agent: AgentView }) {
  const total = agent.jobs_passed + agent.jobs_partial + agent.jobs_failed;
  if (total === 0) return <span className="text-xs text-slate-400">no history</span>;
  return (
    <div className="flex flex-col gap-1 min-w-[90px]">
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
        <div style={{ width: `${(agent.jobs_passed  / total) * 100}%` }} className="bg-emerald-500" />
        <div style={{ width: `${(agent.jobs_partial / total) * 100}%` }} className="bg-amber-400" />
        <div style={{ width: `${(agent.jobs_failed  / total) * 100}%` }} className="bg-red-400" />
      </div>
      <span className="text-[11px] text-slate-500 tabular-nums">
        <span className="text-emerald-600 font-medium">{agent.jobs_passed}</span>
        {' / '}
        <span className="text-amber-500">{agent.jobs_partial}</span>
        {' / '}
        <span className="text-red-500">{agent.jobs_failed}</span>
      </span>
    </div>
  );
}

function PremiumBadge({ bps }: { bps: number }) {
  const pct = bps / 100;
  const [color, bg, border] =
    pct < 2   ? ['#15803d', '#f0fdf4', '#bbf7d0'] :
    pct < 5   ? ['#b45309', '#fffbeb', '#fde68a'] :
                ['#b91c1c', '#fef2f2', '#fecaca'];
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold tabular-nums"
      style={{ color, backgroundColor: bg, border: `1px solid ${border}` }}>
      {pct < 2 ? <TrendingDown className="h-3 w-3" /> : <TrendingUp className="h-3 w-3" />}
      {formatBps(bps)}
    </span>
  );
}

function AgentRow({ agent, rank }: { agent: AgentView; rank: number }) {
  return (
    <tr className="border-b border-slate-100 hover:bg-slate-50/80 transition-colors group">
      <td className="py-3.5 pl-5 pr-4">
        <div className="flex items-center gap-3">
          <span className="tabular-nums text-xs text-slate-400 font-medium w-5 shrink-0">{rank}</span>
          <div className="h-8 w-8 rounded-full bg-gradient-to-br from-blue-400 to-violet-600 flex items-center justify-center shrink-0">
            <Shield className="h-3.5 w-3.5 text-white" />
          </div>
          <div>
            <Link to={`/agents/${agent.agent_id}`}
              className="flex items-center gap-1 text-sm font-medium text-slate-900 hover:text-blue-600 transition-colors">
              {agent.agent_id}
              <ArrowUpRight className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
            </Link>
            <p className="text-[11px] text-slate-400 mt-0.5">since {timeAgo(agent.registered_ms)}</p>
          </div>
        </div>
      </td>
      <td className="py-3.5 pr-4 text-right">
        <span className="text-sm font-semibold text-slate-900 tabular-nums">{formatUSDC(agent.bond, 0)}</span>
      </td>
      <td className="py-3.5 pr-4 text-right hidden sm:table-cell">
        <span className="text-sm text-slate-600 tabular-nums">{formatUSDC(agent.pool_total, 0)}</span>
      </td>
      <td className="py-3.5 pr-4 text-right hidden md:table-cell">
        <span className="text-sm text-slate-600 tabular-nums">{formatUSDC(agent.open_exposure, 0)}</span>
      </td>
      <td className="py-3.5 pr-4 hidden sm:table-cell">
        <RecordBar agent={agent} />
      </td>
      <td className="py-3.5 pr-4">
        <PremiumBadge bps={agent.premium_bps} />
      </td>
      <td className="py-3.5 pr-5 hidden lg:table-cell">
        <Sparkline data={agent.price_history ?? []} />
      </td>
    </tr>
  );
}

function SortBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
        active ? 'bg-slate-900 text-white shadow-sm' : 'bg-white border border-slate-200 text-slate-600 hover:border-slate-300'
      }`}>
      {label}
    </button>
  );
}

type SortKey = 'premium_bps' | 'bond' | 'jobs';

export function Agents() {
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<SortKey>('premium_bps');

  useEffect(() => {
    fetchAgents().then(setAgents).finally(() => setLoading(false));
  }, []);

  const sorted = [...agents].sort((a, b) => {
    if (sort === 'premium_bps') return a.premium_bps - b.premium_bps;
    if (sort === 'bond') return Number(BigInt(b.bond) - BigInt(a.bond));
    const ta = a.jobs_passed + a.jobs_partial + a.jobs_failed;
    const tb = b.jobs_passed + b.jobs_partial + b.jobs_failed;
    return tb - ta;
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">Agents</h1>
          <p className="mt-1 text-sm text-slate-500">
            Registered agents sorted by insurance premium. Lower % = better record.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400 mr-1">Sort by</span>
          <SortBtn label="Premium" active={sort === 'premium_bps'} onClick={() => setSort('premium_bps')} />
          <SortBtn label="Bond"    active={sort === 'bond'}        onClick={() => setSort('bond')} />
          <SortBtn label="Jobs"    active={sort === 'jobs'}        onClick={() => setSort('jobs')} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4 text-xs text-slate-500">
        {[['emerald-500', 'Pass'], ['amber-400', 'Partial'], ['red-400', 'Fail']].map(([c, l]) => (
          <span key={l} className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full bg-${c}`} />{l}
          </span>
        ))}
        <span className="flex items-center gap-1.5 ml-auto">
          <TrendingDown className="h-3.5 w-3.5 text-emerald-500" />premium decreasing (improving)
        </span>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex items-center gap-2 p-8 text-sm text-slate-500"><Spinner size="sm" /> Loading…</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full" aria-label="Agents table">
              <thead>
                <tr style={{ borderBottom: '1px solid #f1f5f9' }}>
                  {[
                    ['Agent', 'pl-5 text-left'],
                    ['Bond', 'text-right'],
                    ['Pool', 'text-right hidden sm:table-cell'],
                    ['Exposure', 'text-right hidden md:table-cell'],
                    ['Pass / Partial / Fail', 'hidden sm:table-cell'],
                    ['Premium %', ''],
                    ['Trend', 'hidden lg:table-cell'],
                  ].map(([label, cls]) => (
                    <th key={String(label)} scope="col"
                      className={`py-3 pr-4 text-[11px] font-semibold text-slate-400 uppercase tracking-wider bg-slate-50/70 ${cls}`}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((a, i) => <AgentRow key={a.agent_id} agent={a} rank={i + 1} />)}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

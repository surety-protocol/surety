import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { ArrowLeft, Shield, TrendingDown, TrendingUp } from 'lucide-react';
import { fetchAgent } from '../lib/rpc';
import { formatUSDC, formatBps, timeAgo } from '../lib/format';
import { Card } from '../components/Card';
import { Spinner } from '../components/Spinner';
import type { AgentWithHistory } from '../shared/types';

function StatTile({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">{label}</p>
      <p className="text-xl font-bold text-slate-900 tabular-nums" style={accent ? { color: accent } : {}}>
        {value}
      </p>
      {sub && <p className="text-xs text-slate-400">{sub}</p>}
    </div>
  );
}

export function AgentDetail() {
  const { id } = useParams<{ id: string }>();
  const [agent, setAgent] = useState<AgentWithHistory | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (id) fetchAgent(id).then(setAgent).finally(() => setLoading(false));
  }, [id]);

  if (loading) return (
    <div className="flex items-center gap-2 py-8 text-sm text-slate-500"><Spinner size="sm" /> Loading…</div>
  );
  if (!agent) return (
    <div className="space-y-4">
      <Link to="/agents" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-blue-600">
        <ArrowLeft className="h-4 w-4" /> Agents
      </Link>
      <p className="text-sm text-slate-500">Agent not found.</p>
    </div>
  );

  const total = agent.jobs_passed + agent.jobs_partial + agent.jobs_failed;
  const passRate = total > 0 ? (agent.jobs_passed / total) * 100 : 0;
  const priceHistory = agent.price_history ?? [];

  const trend = priceHistory.length > 1
    ? priceHistory[priceHistory.length - 1].premium_bps - priceHistory[0].premium_bps
    : 0;

  const chartData = priceHistory.map((p) => ({
    date: new Date(p.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    premium: +(p.premium_bps / 100).toFixed(2),
  }));

  const avgPremium = chartData.length > 0
    ? chartData.reduce((s, p) => s + p.premium, 0) / chartData.length
    : 0;

  return (
    <div className="space-y-6">
      <Link to="/agents" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-blue-600 transition-colors">
        <ArrowLeft className="h-4 w-4" /> All agents
      </Link>

      {/* Header */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="h-2 w-full" style={{ background: 'linear-gradient(to right, #2563eb, #7c3aed)' }} />
        <div className="px-6 py-6 flex items-start gap-4">
          <div className="h-14 w-14 rounded-2xl bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center shrink-0 shadow-lg shadow-blue-500/20">
            <Shield className="h-7 w-7 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-bold text-slate-900 break-all font-mono">{agent.agent_id}</h1>
            <p className="text-sm text-slate-500 mt-0.5">Registered {timeAgo(agent.registered_ms)}</p>
            <p className="text-xs text-slate-400 mt-0.5">
              Failure rate: <span className="font-mono font-medium text-slate-600">{(agent.failure_rate_bps / 100).toFixed(2)}%</span>
              <span className="ml-3">Backers: <span className="font-medium text-slate-600">{agent.backers.length}</span></span>
            </p>
          </div>
          <div className="shrink-0 text-right">
            <div className="flex items-center gap-1 justify-end">
              {trend <= 0
                ? <TrendingDown className="h-4 w-4 text-emerald-500" />
                : <TrendingUp   className="h-4 w-4 text-red-500" />
              }
              <span className="text-xl font-bold tabular-nums"
                style={{ color: agent.premium_bps < 200 ? '#15803d' : agent.premium_bps < 500 ? '#b45309' : '#b91c1c' }}>
                {formatBps(agent.premium_bps)}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">current premium</p>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card><StatTile label="Bond"          value={formatUSDC(agent.bond, 0)}         sub="locked collateral" /></Card>
        <Card><StatTile label="Pool total"    value={formatUSDC(agent.pool_total, 0)}   sub={`${agent.backers.length} backer(s)`} /></Card>
        <Card><StatTile label="Open exposure" value={formatUSDC(agent.open_exposure, 0)} sub="at risk now" /></Card>
        <Card>
          <StatTile
            label="Pass rate"
            value={`${passRate.toFixed(1)}%`}
            sub={`${total} total jobs`}
            accent={passRate >= 90 ? '#15803d' : passRate >= 60 ? '#b45309' : '#b91c1c'}
          />
        </Card>
      </div>

      {/* Record */}
      <Card>
        <h2 className="text-sm font-semibold text-slate-900 mb-4">Job record</h2>
        <div className="flex items-center gap-6 flex-wrap mb-4">
          {[
            { label: 'Passed',  n: agent.jobs_passed,  color: '#22c55e', bg: '#f0fdf4' },
            { label: 'Partial', n: agent.jobs_partial, color: '#f59e0b', bg: '#fffbeb' },
            { label: 'Failed',  n: agent.jobs_failed,  color: '#ef4444', bg: '#fef2f2' },
          ].map(({ label, n, color, bg }) => (
            <div key={label} className="flex flex-col items-center justify-center h-20 w-20 rounded-2xl" style={{ backgroundColor: bg }}>
              <span className="text-2xl font-bold tabular-nums" style={{ color }}>{n}</span>
              <span className="text-xs font-medium mt-0.5" style={{ color }}>{label}</span>
            </div>
          ))}
          {total > 0 && (
            <div className="flex-1 min-w-[120px]">
              <div className="flex h-3 w-full overflow-hidden rounded-full bg-slate-100">
                <div style={{ width: `${(agent.jobs_passed  / total) * 100}%` }} className="bg-emerald-500 transition-all duration-500" />
                <div style={{ width: `${(agent.jobs_partial / total) * 100}%` }} className="bg-amber-400" />
                <div style={{ width: `${(agent.jobs_failed  / total) * 100}%` }} className="bg-red-400" />
              </div>
              <p className="mt-2 text-xs text-slate-400">{total} total jobs</p>
            </div>
          )}
        </div>
      </Card>

      {/* Premium chart */}
      {chartData.length > 1 && (
        <Card>
          <div className="flex items-center justify-between mb-5">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Premium % over time</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Derived from settled jobs — lower is better
              </p>
            </div>
            <span className="text-xs text-slate-400">avg {avgPremium.toFixed(2)}%</span>
          </div>
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#94a3b8' }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}%`} />
                <ReferenceLine y={avgPremium} stroke="#e2e8f0" strokeDasharray="4 4"
                  label={{ value: 'avg', fill: '#94a3b8', fontSize: 10 }} />
                <Tooltip
                  formatter={(v: number) => [`${v}%`, 'Premium']}
                  contentStyle={{ fontSize: 12, borderRadius: 10, border: '1px solid #e2e8f0', boxShadow: '0 4px 12px rgba(0,0,0,0.08)' }}
                />
                <Line type="monotone" dataKey="premium"
                  stroke={trend <= 0 ? '#22c55e' : '#ef4444'}
                  strokeWidth={2.5} dot={false} activeDot={{ r: 5, strokeWidth: 0 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      {/* Backers */}
      {agent.backers.length > 0 && (
        <Card>
          <h2 className="text-sm font-semibold text-slate-900 mb-3">Backers</h2>
          <ul className="divide-y divide-slate-50">
            {agent.backers.map((b) => (
              <li key={b.backer_id} className="flex items-center justify-between py-2.5">
                <span className="text-sm font-mono text-slate-700">{b.backer_id}</span>
                <span className="text-sm font-semibold text-slate-900 tabular-nums">{formatUSDC(b.amount, 0)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

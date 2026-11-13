import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Clock, FileText } from 'lucide-react';
import { fetchJobs } from '../lib/rpc';
import { formatUSDC, timeAgo, shortAccount } from '../lib/format';
import { StatusChip } from '../components/StatusChip';
import { Spinner } from '../components/Spinner';
import type { JobView, JobStatus } from '../shared/types';

const ALL_STATUSES: JobStatus[] = ['Open','Accepted','Delivered','Judged','Appealed','Settled','Cancelled'];

function JobCard({ job }: { job: JobView }) {
  return (
    <Link
      to={`/jobs/${job.job_id}`}
      className="block bg-white border border-slate-200 rounded-xl p-5 hover:border-blue-300 hover:shadow-md transition-all duration-150 group"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip status={job.status} />
            <span className="text-[11px] font-mono text-slate-400">#{job.job_id}</span>
          </div>

          {/* Spec URL or hash */}
          <div className="flex items-center gap-1.5 text-sm">
            <FileText className="h-3.5 w-3.5 text-slate-400 shrink-0" />
            {job.spec_url ? (
              <span className="text-slate-800 font-medium group-hover:text-blue-700 transition-colors truncate">
                {job.spec_url.replace('https://spec.surety.dev/jobs/', 'Job spec #')}
              </span>
            ) : (
              <span className="font-mono text-xs text-slate-400 truncate">{job.spec_hash.slice(0, 24)}…</span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
            <span>Client: <span className="font-medium text-slate-600">{shortAccount(job.client_id)}</span></span>
            {job.agent_id && (
              <span>Agent: <span className="font-medium text-slate-600">{shortAccount(job.agent_id)}</span></span>
            )}
            {job.premium_bps !== null && (
              <span className="text-slate-500">Premium: <span className="font-medium">{(job.premium_bps / 100).toFixed(2)}%</span></span>
            )}
            <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{timeAgo(job.posted_ms)}</span>
          </div>
        </div>

        <div className="shrink-0 text-right flex flex-col items-end gap-2">
          <p className="text-base font-bold text-slate-900 tabular-nums">{formatUSDC(job.value, 0)}</p>
          <ArrowUpRight className="h-4 w-4 text-slate-300 group-hover:text-blue-500 transition-colors" />
        </div>
      </div>

      {/* Settlement preview */}
      {job.settlement && (
        <div className="mt-3 pt-3 flex flex-wrap gap-3 text-xs" style={{ borderTop: '1px solid #f1f5f9' }}>
          <span className="text-slate-500">
            Outcome: <span className={`font-semibold ${
              job.settlement.outcome === 'Pass' ? 'text-emerald-600' :
              job.settlement.outcome === 'Partial' ? 'text-amber-600' : 'text-red-600'
            }`}>{job.settlement.outcome}</span>
          </span>
          {BigInt(job.settlement.to_agent) > 0n && (
            <span className="text-emerald-600">↗ {formatUSDC(job.settlement.to_agent, 0)} to agent</span>
          )}
          {BigInt(job.settlement.to_client) > 0n && (
            <span className="text-red-500">↩ {formatUSDC(job.settlement.to_client, 0)} refunded</span>
          )}
          {BigInt(job.settlement.to_pool) > 0n && (
            <span className="text-blue-500">⊕ {formatUSDC(job.settlement.to_pool, 0)} to pool</span>
          )}
        </div>
      )}
    </Link>
  );
}

function FilterPill({ label, count, active, onClick }: {
  label: string; count: number; active: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-medium transition-all ${
        active ? 'bg-slate-900 text-white shadow-sm' : 'bg-white border border-slate-200 text-slate-600 hover:border-slate-300'
      }`}
    >
      {label}
      <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none ${
        active ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500'
      }`}>{count}</span>
    </button>
  );
}

export function Jobs() {
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<JobStatus | 'All'>('All');

  useEffect(() => {
    fetchJobs().then(setJobs).finally(() => setLoading(false));
  }, []);

  const filtered = filter === 'All' ? jobs : jobs.filter((j) => j.status === filter);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-900 tracking-tight">Jobs</h1>
        <p className="mt-1 text-sm text-slate-500">
          All jobs on-chain. Click any card for checks, judge verdicts, and settlement breakdown.
        </p>
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by status">
        {(['All', ...ALL_STATUSES] as const).map((s) => {
          const count = s === 'All' ? jobs.length : jobs.filter((j) => j.status === s).length;
          return <FilterPill key={s} label={s} count={count} active={filter === s} onClick={() => setFilter(s)} />;
        })}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-slate-500"><Spinner size="sm" /> Loading jobs…</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 p-12 text-center">
          <p className="text-sm text-slate-400">No jobs matching this filter.</p>
        </div>
      ) : (
        <div className="grid gap-3">{filtered.map((j) => <JobCard key={j.job_id} job={j} />)}</div>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  CheckCircle2, XCircle, ArrowLeft, ExternalLink,
  ShieldCheck, ShieldX, Scale, FileCode2, Loader2
} from 'lucide-react';
import { fetchJob, fetchReceipt, receiptUrl } from '../lib/rpc';
import { formatUSDC, timeAgo } from '../lib/format';
import { Card } from '../components/Card';
import { StatusChip } from '../components/StatusChip';
import { VoteChip } from '../components/VoteChip';
import { Spinner } from '../components/Spinner';
import type { AiVote, CheckResult, JobView, Verdict } from '../shared/types';

// ── Check row ─────────────────────────────────────────────────────────────────

function CheckRow({ check }: { check: CheckResult }) {
  return (
    <li className="flex items-start gap-3 py-3 border-b border-slate-50 last:border-0">
      {check.pass
        ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500 mt-0.5" aria-label="Passed" />
        : <XCircle     className="h-4 w-4 shrink-0 text-red-500 mt-0.5"     aria-label="Failed" />
      }
      <div className="min-w-0 flex-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mr-2">
          {check.type === "test" ? "Test" : "AI check"}
        </span>
        {check.type === "test"
          ? <code className="text-xs font-mono text-slate-700">{check.name}</code>
          : <span className="text-sm text-slate-700">{check.question}</span>}
      </div>
    </li>
  );
}

// ── Judge card (one model's vote on one AI check) ──────────────────────────────

function JudgeCard({ vote, jobId }: { vote: AiVote; jobId: number }) {
  const borderColor = vote.pass ? "#bbf7d0" : "#fecaca";
  const headerBg    = vote.pass ? "#f0fdf4" : "#fef2f2";
  const verified = vote.attestation_verified && vote.signature_verified;

  return (
    <div className="rounded-xl border overflow-hidden" style={{ borderColor }}>
      <div className="flex items-center justify-between gap-3 px-4 py-3 flex-wrap" style={{ backgroundColor: headerBg }}>
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <code className="text-xs font-mono text-slate-600 bg-white/70 rounded px-2 py-0.5 truncate max-w-[220px]">{vote.model}</code>
          <VoteChip pass={vote.pass} />
        </div>
        {verified ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 border border-emerald-200 px-2.5 py-0.5 text-xs font-medium text-emerald-700 shrink-0"
            title="TEE attestation (Intel TDX + NVIDIA GPU) and response signature both verified">
            <ShieldCheck className="h-3 w-3" /> TEE verified
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 border border-amber-200 px-2.5 py-0.5 text-xs font-medium text-amber-700 shrink-0"
            title={vote.problems.join("; ") || "not verified"}>
            <ShieldX className="h-3 w-3" /> Not verified
          </span>
        )}
      </div>
      <div className="px-4 py-3 space-y-2 bg-white">
        <p className="text-sm text-slate-700 leading-relaxed">{vote.reason}</p>
        <a href={receiptUrl(jobId, `judge-${vote.model.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`)} target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline">
          <ExternalLink className="h-3 w-3" /> Raw attestation receipt
        </a>
      </div>
    </div>
  );
}

// ── Settlement panel ──────────────────────────────────────────────────────────

function SettlementPanel({ job }: { job: JobView }) {
  if (!job.settlement) return null;
  const { settlement } = job;
  const items = [
    { label: 'Outcome',               value: settlement.outcome, isOutcome: true },
    { label: 'To agent',              value: settlement.to_agent,  color: '#15803d' },
    { label: 'Refunded to client',    value: settlement.to_client, color: BigInt(settlement.to_client) > 0n ? '#dc2626' : '#94a3b8' },
    { label: 'To backer pool',        value: settlement.to_pool,   color: '#2563eb' },
    { label: 'From agent bond',       value: settlement.from_bond, color: BigInt(settlement.from_bond) > 0n ? '#dc2626' : '#94a3b8' },
    { label: 'From backer pool',      value: settlement.from_pool, color: BigInt(settlement.from_pool) > 0n ? '#dc2626' : '#94a3b8' },
  ];

  return (
    <Card>
      <div className="flex items-center gap-2 mb-4">
        <Scale className="h-4 w-4 text-slate-400" />
        <h2 className="text-sm font-semibold text-slate-900">Settlement breakdown</h2>
        <span className={`ml-auto text-xs font-bold px-2 py-0.5 rounded-full ${
          settlement.outcome === 'Pass'    ? 'bg-emerald-50 text-emerald-700' :
          settlement.outcome === 'Partial' ? 'bg-amber-50 text-amber-700' :
          'bg-red-50 text-red-700'
        }`}>{settlement.outcome}</span>
      </div>
      <ul className="space-y-0 divide-y divide-slate-50">
        {items.filter((i) => !i.isOutcome).map(({ label, value, color }) => (
          <li key={label} className="flex items-center justify-between py-2.5">
            <span className="text-sm text-slate-600">{label}</span>
            <span className="text-sm font-bold tabular-nums" style={{ color: color as string }}>
              {formatUSDC(value as string, 2)}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex items-center gap-3 flex-wrap text-xs text-slate-400">
        <span>Settled {timeAgo(settlement.settled_ms)}</span>
      </div>
    </Card>
  );
}

// ── Receipts panel (receipts/<job>/verdict.json, SPEC section 6) ──────────────

function ReceiptsPanel({ verdict }: { verdict: Verdict }) {
  const aiChecks = verdict.checks.filter((c): c is Extract<CheckResult, { type: "ai" }> => c.type === "ai");
  const allPass = verdict.checks_passed === verdict.checks_total;
  return (
    <>
      <Card>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-slate-900">Checks</h2>
          <span className={`text-sm font-bold tabular-nums ${allPass ? "text-emerald-600" : "text-red-600"}`}>
            {verdict.checks_passed}/{verdict.checks_total} passed · score {(verdict.score_bps / 100).toFixed(2)}%
          </span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-slate-100 mb-4 overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${verdict.checks_total ? (verdict.checks_passed / verdict.checks_total) * 100 : 0}%`,
              backgroundColor: allPass ? "#22c55e" : "#ef4444",
            }}
          />
        </div>
        <ul className="divide-y divide-slate-50" role="list">
          {verdict.checks.map((c) => <CheckRow key={c.id} check={c} />)}
        </ul>
        {verdict.problems.length > 0 && (
          <p className="mt-3 text-xs text-amber-700">Judge notes: {verdict.problems.join("; ")}</p>
        )}
        <a href={receiptUrl(verdict.job_id, "verdict.json")} target="_blank" rel="noopener noreferrer"
          className="mt-3 inline-flex items-center gap-1 text-xs text-blue-600 hover:underline">
          <ExternalLink className="h-3 w-3" /> verdict.json (its sha256 is stored on-chain as receipts_hash)
        </a>
      </Card>

      {aiChecks.map((c) => (
        <section key={c.id}>
          <div className="flex items-center justify-between mb-3 gap-3">
            <h2 className="text-sm font-semibold text-slate-900">AI judges: {c.question}</h2>
            <span className="text-xs text-slate-400 font-medium shrink-0">
              {c.votes.filter((v) => v.attestation_verified && v.signature_verified).length}/{c.votes.length} votes TEE-verified
            </span>
          </div>
          <div className="space-y-3">
            {c.votes.map((v) => <JudgeCard key={v.model} vote={v} jobId={verdict.job_id} />)}
          </div>
        </section>
      ))}
    </>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function JobDetail() {
  const { id } = useParams<{ id: string }>();
  const jobId = Number(id);

  const [job, setJob]         = useState<JobView | null>(null);
  const [receipt, setReceipt] = useState<Verdict | null>(null);
  const [loadingJob, setLoadingJob]         = useState(true);
  const [loadingReceipt, setLoadingReceipt] = useState(false);

  useEffect(() => {
    if (!Number.isFinite(jobId)) return;
    fetchJob(jobId).then(setJob).finally(() => setLoadingJob(false));
  }, [jobId]);

  // Load receipt when job is settled/judged
  useEffect(() => {
    if (!job) return;
    if (job.status === 'Settled' || job.status === 'Judged' || job.status === 'Appealed') {
      setLoadingReceipt(true);
      fetchReceipt(job.job_id).then(setReceipt).finally(() => setLoadingReceipt(false));
    }
  }, [job]);

  if (loadingJob) return (
    <div className="flex items-center gap-2 py-8 text-sm text-slate-500"><Spinner size="sm" /> Loading job…</div>
  );
  if (!job) return (
    <div className="space-y-4">
      <Link to="/jobs" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-blue-600">
        <ArrowLeft className="h-4 w-4" /> Jobs
      </Link>
      <p className="text-sm text-slate-500">Job not found.</p>
    </div>
  );

  return (
    <div className="space-y-6">
      <Link to="/jobs" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-blue-600 transition-colors">
        <ArrowLeft className="h-4 w-4" /> All jobs
      </Link>

      {/* Header */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-6 py-5 border-b border-slate-100">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2 flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <StatusChip status={job.status} />
                <code className="text-xs font-mono text-slate-400">#{job.job_id}</code>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
                <span>Posted {timeAgo(job.posted_ms)}</span>
                {job.settlement && <span>Settled {timeAgo(job.settlement.settled_ms)}</span>}
                {job.premium_bps !== null && <span>Premium locked: {(job.premium_bps / 100).toFixed(2)}%</span>}
              </div>
            </div>
            <div className="text-right shrink-0">
              <p className="text-2xl font-bold text-slate-900 tabular-nums">{formatUSDC(job.value, 0)}</p>
              <p className="text-xs text-slate-400 mt-0.5">escrowed</p>
            </div>
          </div>
        </div>

        {/* Participants */}
        <div className="px-6 py-4 grid grid-cols-2 gap-4 bg-slate-50/50">
          <div>
            <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Client</p>
            <p className="text-sm font-medium text-slate-800 font-mono">{job.client_id}</p>
          </div>
          <div>
            <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Agent</p>
            {job.agent_id ? (
              <Link to={`/agents/${job.agent_id}`} className="text-sm font-medium text-blue-600 hover:underline font-mono">
                {job.agent_id}
              </Link>
            ) : (
              <p className="text-sm text-slate-400 italic">Not yet accepted</p>
            )}
          </div>
        </div>
      </div>

      {/* Spec */}
      <Card>
        <div className="flex items-center gap-2 mb-3">
          <FileCode2 className="h-4 w-4 text-slate-400" />
          <h2 className="text-sm font-semibold text-slate-900">Spec</h2>
        </div>
        <div className="space-y-2">
          {job.spec_url && (
            <a href={job.spec_url} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline font-medium">
              <ExternalLink className="h-3.5 w-3.5" /> {job.spec_url}
            </a>
          )}
          <p className="text-xs font-mono text-slate-400 break-all">
            sha256: {job.spec_hash.replace('sha256:', '')}
          </p>
        </div>
      </Card>

      {/* Receipt — checks + judge votes */}
      {loadingReceipt ? (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin text-blue-500" /> Loading receipt…
        </div>
      ) : receipt ? (
        <ReceiptsPanel verdict={receipt} />
      ) : (job.status === 'Settled' || job.status === 'Judged') ? (
        <Card className="bg-slate-50 border-slate-200">
          <p className="text-sm text-slate-500">Receipt not available yet.</p>
        </Card>
      ) : null}

      {/* Settlement */}
      {job.settlement && <SettlementPanel job={job} />}

      {/* Judging in progress */}
      {(job.status === 'Delivered' || job.status === 'Accepted') && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 flex items-center gap-3">
          <Spinner size="sm" className="text-amber-500 shrink-0" />
          <p className="text-sm text-amber-800 font-medium">
            Waiting for the judge service to process this submission.
          </p>
        </div>
      )}
    </div>
  );
}

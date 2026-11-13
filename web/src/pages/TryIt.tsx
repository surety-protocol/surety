import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, XCircle, Clock, Loader2, ArrowRight, Zap, AlertTriangle, Trophy } from 'lucide-react';
import { startDemoRun, pollDemoStatus } from '../lib/demo';
import { Card } from '../components/Card';
import type { DemoScenario, DemoRun, DemoStep } from '../shared/types';

// ── Agent option card ─────────────────────────────────────────────────────────

const AGENT_OPTIONS: {
  type: DemoScenario;
  label: string;
  tag: string;
  description: string;
  outcome: string;
  icon: string;
  gradient: string;
  border: string;
  tagColor: string;
}[] = [
  {
    type: 'honest',
    label: 'Honest agent',
    tag: '7/7 checks',
    description: 'Fixes the login bug properly and touches only the allowed files.',
    outcome: 'Pass → the agent gets the 50 tUSDC escrow minus its premium: 7% (3.50 tUSDC) for a new agent, less as its record grows.',
    icon: '🏆',
    gradient: 'linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%)',
    border: '#86efac',
    tagColor: '#15803d',
  },
  {
    type: 'sloppy',
    label: 'Sloppy agent',
    tag: '2/7 checks',
    description: 'Throws the wrong error, breaks the lockout counter and weakens session tokens.',
    outcome: 'Fail → client gets 60 tUSDC back (50 escrow + 10 penalty from the bond).',
    icon: '⚠️',
    gradient: 'linear-gradient(135deg, #fffbeb 0%, #fef3c7 100%)',
    border: '#fcd34d',
    tagColor: '#b45309',
  },
  {
    type: 'cheater',
    label: 'Cheater agent',
    tag: 'Sock puppet',
    description: 'Hires itself through fake client accounts for easy jobs to look reliable.',
    outcome: 'Pass, but each repeat job from the same client counts only value / k toward its record.',
    icon: '🚫',
    gradient: 'linear-gradient(135deg, #fff1f2 0%, #ffe4e6 100%)',
    border: '#fca5a5',
    tagColor: '#b91c1c',
  },
];

// ── Step row ──────────────────────────────────────────────────────────────────

function StepRow({ step, index, total }: { step: DemoStep; index: number; total: number }) {
  const isDone    = step.status === 'done';
  const isRunning = step.status === 'running';
  const isError   = step.status === 'failed';

  return (
    <li className="flex items-start gap-3">
      <div className="flex flex-col items-center shrink-0">
        <div className={`h-7 w-7 rounded-full flex items-center justify-center ring-2 transition-all duration-300 ${
          isDone    ? 'bg-emerald-500 ring-emerald-200'
          : isRunning ? 'bg-blue-500 ring-blue-200 ring-offset-2'
          : isError   ? 'bg-red-500 ring-red-200'
          : 'bg-slate-100 ring-slate-200'
        }`}>
          {isDone    ? <CheckCircle2 className="h-4 w-4 text-white" />
           : isRunning ? <Loader2 className="h-3.5 w-3.5 text-white animate-spin" />
           : isError   ? <XCircle className="h-4 w-4 text-white" />
           : <Clock className="h-3.5 w-3.5 text-slate-400" />}
        </div>
        {index < total - 1 && (
          <div className={`w-0.5 h-6 mt-1 transition-all duration-300 ${isDone ? 'bg-emerald-300' : 'bg-slate-200'}`} />
        )}
      </div>

      <div className="pt-1 pb-6 min-w-0">
        {/* API field is "name", not "label" */}
        <p className={`text-sm transition-colors ${
          isDone    ? 'text-slate-800 font-medium'
          : isRunning ? 'text-blue-700 font-semibold'
          : isError   ? 'text-red-700 font-medium'
          : 'text-slate-400'
        }`}>
          {step.name}
        </p>
        {step.detail && <p className="mt-0.5 text-xs text-slate-400 font-mono">{step.detail}</p>}
        {step.tx_url && (
          <a href={step.tx_url} target="_blank" rel="noopener noreferrer" className="mt-0.5 inline-block text-xs text-blue-600 hover:underline">
            View transaction
          </a>
        )}
        {step.at_ms && isDone && (
          <p className="mt-0.5 text-[10px] text-slate-300">
            {new Date(step.at_ms).toLocaleTimeString()}
          </p>
        )}
      </div>
    </li>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function TryIt() {
  const [run, setRun]         = useState<DemoRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [selected, setSelected] = useState<DemoScenario | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (run?.status === 'done' || run?.status === 'error') {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    }
  }, [run?.status]);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  async function handleStart(type: DemoScenario) {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    setRun(null); setError(null); setLoading(true); setSelected(type);

    try {
      const newRun = await startDemoRun(type);
      setRun(newRun);
      setLoading(false);

      pollRef.current = setInterval(async () => {
        try {
          const updated = await pollDemoStatus(newRun);
          setRun(updated);
        } catch { /* ignore transient */ }
      }, 600);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start demo');
      setLoading(false);
    }
  }

  // Steps arrive as they happen; while running, show a spinner row for the next one.
  const activeSteps: DemoStep[] | undefined = run ? (run.status === 'running'
    ? [...run.steps, { name: 'working…', status: 'running', at_ms: Date.now() }]
    : run.steps) : undefined;

  const selectedOption = AGENT_OPTIONS.find((a) => a.type === selected);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-bold text-slate-900 tracking-tight">Try It</h1>
        <p className="mt-1 text-sm text-slate-500">
          Run a complete job end-to-end on NEAR testnet. No wallet needed — just watch.
        </p>
      </div>

      {/* Agent selector */}
      <section>
        <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Choose a scenario</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          {AGENT_OPTIONS.map((a) => {
            const isActive = selected === a.type && (loading || !!run);
            return (
              <button
                key={a.type}
                onClick={() => handleStart(a.type)}
                disabled={loading}
                style={{
                  background: a.gradient,
                  border: `2px solid ${isActive ? a.border : 'transparent'}`,
                  boxShadow: isActive ? `0 0 0 4px ${a.border}40` : undefined,
                }}
                className="text-left rounded-xl p-5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                aria-pressed={isActive}
              >
                <div className="flex items-start justify-between mb-3">
                  <span className="text-2xl" role="img">{a.icon}</span>
                  <span className="text-[11px] font-bold rounded-full px-2.5 py-0.5"
                    style={{ color: a.tagColor, backgroundColor: 'white', border: `1px solid ${a.border}` }}>
                    {a.tag}
                  </span>
                </div>
                <p className="text-sm font-bold text-slate-900 mb-1">{a.label}</p>
                <p className="text-xs text-slate-600 mb-3">{a.description}</p>
                <div className="rounded-lg p-2.5 text-xs"
                  style={{ backgroundColor: 'rgba(255,255,255,0.6)', border: `1px solid ${a.border}40` }}>
                  <span className="font-medium text-slate-500">Expected: </span>
                  <span className="text-slate-700">{a.outcome}</span>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
          <AlertTriangle className="h-4 w-4 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {loading && !run && (
        <div className="flex items-center gap-3 rounded-xl border border-blue-100 bg-blue-50 px-4 py-3">
          <Loader2 className="h-4 w-4 animate-spin text-blue-500 shrink-0" />
          <p className="text-sm text-blue-700">Starting job on testnet…</p>
        </div>
      )}

      {/* Progress */}
      {run && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 bg-slate-50/60">
            <div className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-blue-500" />
              <span className="text-sm font-semibold text-slate-900">
                {selectedOption?.label}{run.job_id >= 0 ? ` — job #${run.job_id}` : ''}
              </span>
            </div>
            {run.status === 'running' && (
              <span className="inline-flex items-center gap-1.5 text-xs text-blue-600 font-medium">
                <Loader2 className="h-3 w-3 animate-spin" /> In progress
              </span>
            )}
            {run.status === 'done' && (
              <span className="inline-flex items-center gap-1.5 text-xs text-emerald-600 font-semibold">
                <Trophy className="h-3.5 w-3.5" /> Settled
              </span>
            )}
            {run.status === 'error' && (
              <span className="inline-flex items-center gap-1.5 text-xs text-red-600 font-semibold">
                <XCircle className="h-3.5 w-3.5" /> Failed
              </span>
            )}
          </div>

          <div className="px-5 pt-5 pb-2">
            <ol role="list">
              {(activeSteps ?? run.steps).map((step, i, arr) => (
                <StepRow key={i} step={step} index={i} total={arr.length} />
              ))}
            </ol>
          </div>

          {run.status === 'done' && (
            <div className="px-5 pb-5">
              <Link to={`/jobs/${run.job?.job_id ?? run.job_id}`}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-500 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5">
                View full job detail <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          )}
        </div>
      )}

      {/* Explainer */}
      <Card className="bg-slate-50 border-slate-200">
        <h2 className="text-sm font-semibold text-slate-900 mb-4">What happens under the hood</h2>
        <ol className="space-y-3">
          {[
            'Job posted to Surety contract on NEAR testnet — escrow locked.',
            'Demo agent accepts and delivers a pre-canned patch for the scenario.',
            'The judge service applies the patch in a sandbox and runs the client tests.',
            'Three AI models on NEAR AI Cloud, inside TEEs, each vote pass or fail on the AI checks. Majority wins.',
            'The judge submits the score (checks passed / total). After the appeal window the contract settles: pass pays the agent, fail refunds the client plus a 20% penalty from the bond.',
            'Receipts (tests, every vote, attestation proofs) are published; their sha256 is stored on-chain.',
          ].map((text, i) => (
            <li key={i} className="flex gap-3 text-sm text-slate-600">
              <span className="shrink-0 h-5 w-5 rounded-full bg-slate-200 text-[11px] font-bold text-slate-600 flex items-center justify-center mt-0.5">
                {i + 1}
              </span>
              {text}
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}

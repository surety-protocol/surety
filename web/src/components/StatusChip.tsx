import type { JobStatus } from '../shared/types';

const STYLES: Record<JobStatus, { bg: string; text: string; dot: string; border: string }> = {
  Open:      { bg: '#eff6ff', text: '#1d4ed8', dot: '#3b82f6', border: '#bfdbfe' },
  Accepted:  { bg: '#f5f3ff', text: '#5b21b6', dot: '#7c3aed', border: '#ddd6fe' },
  Delivered: { bg: '#fffbeb', text: '#92400e', dot: '#d97706', border: '#fde68a' },
  Judged:    { bg: '#fff7ed', text: '#9a3412', dot: '#ea580c', border: '#fed7aa' },
  Appealed:  { bg: '#fdf4ff', text: '#7e22ce', dot: '#a855f7', border: '#e9d5ff' },
  Settled:   { bg: '#f8fafc', text: '#475569', dot: '#94a3b8', border: '#e2e8f0' },
  Cancelled: { bg: '#fef2f2', text: '#991b1b', dot: '#ef4444', border: '#fecaca' },
};

export function StatusChip({ status }: { status: JobStatus }) {
  const s = STYLES[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold"
      style={{ backgroundColor: s.bg, color: s.text, border: `1px solid ${s.border}` }}
    >
      <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ backgroundColor: s.dot }} aria-hidden="true" />
      {status}
    </span>
  );
}

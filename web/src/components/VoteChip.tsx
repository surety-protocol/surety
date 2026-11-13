export function VoteChip({ pass }: { pass: boolean }) {
  const s = pass
    ? { bg: '#f0fdf4', text: '#15803d', border: '#bbf7d0' }
    : { bg: '#fef2f2', text: '#991b1b', border: '#fecaca' };
  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold"
      style={{ backgroundColor: s.bg, color: s.text, border: `1px solid ${s.border}` }}
    >
      {pass ? '✓ Pass' : '✗ Fail'}
    </span>
  );
}

/** Format micro-USDC (6 decimals) to human-readable tUSDC string */
export function formatUSDC(microUsdc: string | number, decimals = 2): string {
  const n = typeof microUsdc === 'string' ? BigInt(microUsdc) : BigInt(Math.round(Number(microUsdc)));
  const whole = n / 1_000_000n;
  const frac = n % 1_000_000n;
  const fracStr = frac.toString().padStart(6, '0').slice(0, decimals);
  return decimals > 0 ? `${whole.toLocaleString()}.${fracStr} tUSDC` : `${whole.toLocaleString()} tUSDC`;
}

/** Format basis points to percentage string */
export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

/** Relative time string */
export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Shorten a NEAR account id for display */
export function shortAccount(id: string, maxLen = 20): string {
  if (id.length <= maxLen) return id;
  return id.slice(0, 8) + '…' + id.slice(-6);
}

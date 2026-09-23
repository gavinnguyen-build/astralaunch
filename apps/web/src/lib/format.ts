/** Formatting helpers for USDC amounts (6 dec) and token amounts (18 dec). */

/** Format raw 6-dec bigint or string as "$X.XX" */
export function fmtUsdc(raw: bigint | string | null | undefined, prefix = '$'): string {
  if (raw == null) return '—';
  const n = typeof raw === 'string' ? BigInt(raw) : raw;
  const int  = n / 1_000_000n;
  const frac = n % 1_000_000n;
  const fracStr = frac.toString().padStart(6, '0').slice(0, 2);
  return `${prefix}${int.toLocaleString()}.${fracStr}`;
}

/** Format raw 18-dec bigint as human-readable with K/M/B suffix */
export function fmtToken(raw: bigint | string | null | undefined): string {
  if (raw == null) return '—';
  const n = typeof raw === 'string' ? BigInt(raw) : raw;
  const whole = Number(n / 10n ** 15n) / 1000; // 3 dec places in token units
  if (whole >= 1e9)  return `${(whole / 1e9).toFixed(2)}B`;
  if (whole >= 1e6)  return `${(whole / 1e6).toFixed(2)}M`;
  if (whole >= 1e3)  return `${(whole / 1e3).toFixed(2)}K`;
  return whole.toFixed(2);
}

/** Format a unix timestamp (seconds) as relative time */
export function fmtRelative(ts: number | null | undefined): string {
  if (ts == null) return '—';
  const now = Math.floor(Date.now() / 1000);
  const diff = now - ts;
  if (diff < 60)   return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/** Format a Date as relative */
export function fmtDate(d: Date | string | null | undefined): string {
  if (d == null) return '—';
  return fmtRelative(Math.floor(new Date(d).getTime() / 1000));
}

/** Truncate an address 0x1234...abcd */
export function fmtAddr(addr: string | null | undefined): string {
  if (!addr) return '—';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Format bps as percentage "X.XX%" */
export function fmtBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

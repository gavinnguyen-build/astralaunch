/**
 * Display formatting only. Amounts arrive from the API as exact decimal strings (computed with
 * bigint on the server); converting to Number here is for rendering, never for money math.
 */
export const shortAddr = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—');

/** 1234 → "1.2K", 150600 → "150.6K", 2_500_000 → "2.5M". */
export function compact(v: number | string | null | undefined, dp = 1): string {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(dp)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(dp)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(dp)}K`;
  return a >= 100 ? n.toFixed(0) : a >= 1 ? trim(n.toFixed(2)) : sig(n, 3);
}

/** Small prices keep 3 significant digits: 0.0000025376 → "0.00000254". */
export function sig(n: number, digits = 3): string {
  if (n === 0 || !Number.isFinite(n)) return n === 0 ? '0' : '—';
  if (Math.abs(n) >= 10 ** digits) return Math.round(n).toLocaleString('en-US');
  const s = n.toPrecision(digits);
  return s.includes('e') ? trim(n.toFixed(Math.min(20, digits - Math.floor(Math.log10(Math.abs(n))) - 1))) : trim(s);
}

const trim = (s: string) => (s.includes('.') ? s.replace(/\.?0+$/, '') : s);

/** "$0.00000254", "$2.5K", "$0.15". */
export function fmtUsd(v: string | number | null | undefined, compactLarge = true): string {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1000 && compactLarge) return `$${compact(n)}`;
  if (Math.abs(n) >= 1) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  return `$${sig(n, 3)}`;
}

const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉';
/** Leading zeros after "0." from which a price is shown with a subscript zero count. */
export const PRICE_SUBSCRIPT_FROM = 4;

/**
 * Token price, compact and never in scientific notation:
 * 0.0000025 → "$0.0₅25", 0.0000025376 → "$0.0₅254", 0.00254 → "$0.00254", 1.2345 → "$1.2345", 1234.5 → "$1,235".
 * The subscript is the number of zeros after "0." (DexScreener style). `prefix` is "$" for USD, "" otherwise.
 */
export function fmtPrice(v: string | number | null | undefined, prefix = '$'): string {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return `${prefix}0`;
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (a >= 1) return `${sign}${prefix}${a.toLocaleString('en-US', { maximumFractionDigits: a >= 1000 ? 0 : 4 })}`;
  // 3 significant digits via the exponent form, then written out without "e".
  const [mant, exp] = a.toExponential(2).split('e');
  const zeros = -Number(exp) - 1;
  const digits = mant!.replace('.', '').replace(/0+$/, '') || '0';
  if (zeros < PRICE_SUBSCRIPT_FROM) return `${sign}${prefix}0.${'0'.repeat(Math.max(0, zeros))}${digits}`;
  const sub = String(zeros).split('').map((d) => SUBSCRIPT[Number(d)]).join('');
  return `${sign}${prefix}0.0${sub}${digits}`;
}

/** Token / numeraire amounts: 58006.13 → "58.0K", 0.15 → "0.15". */
export const fmtAmount = (v: string | number | null | undefined) => compact(v);

/** Grouped integer or 2-dp USDC: 3012.5 → "3,012.5". */
export function fmtUsdc(v: string | number | null | undefined): string {
  if (v == null || v === '') return '—';
  const n = Number(v);
  return n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 0 : 2 });
}

/** Basis points → "+0.26%" / "-9.6%". */
export function fmtBps(bps: number | null | undefined): string {
  if (bps == null) return '—';
  const p = bps / 100;
  return `${p >= 0 ? '+' : ''}${Math.abs(p) >= 100 ? p.toFixed(0) : p.toFixed(Math.abs(p) >= 10 ? 1 : 2)}%`;
}

export const isDown = (bps: number | null | undefined) => bps != null && bps < 0;

/** Age from a unix-seconds or Date: "38d", "5h", "12m". */
export function ago(t: number | string | Date | null | undefined, nowMs = Date.now()): string {
  if (t == null) return '—';
  const ms = t instanceof Date ? t.getTime() : typeof t === 'string' ? Date.parse(t) : t * 1000;
  const s = Math.max(0, Math.floor((nowMs - ms) / 1000));
  if (s >= 86_400) return `${Math.floor(s / 86_400)}d`;
  if (s >= 3_600) return `${Math.floor(s / 3_600)}h`;
  if (s >= 60) return `${Math.floor(s / 60)}m`;
  return `${s}s`;
}

export function fmtDate(t: number | string | Date | null | undefined): string {
  if (t == null) return '—';
  const d = t instanceof Date ? t : typeof t === 'string' ? new Date(t) : new Date(t * 1000);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "14:02:11" (local time). */
export function fmtTime(t: number | string | Date): string {
  const d = t instanceof Date ? t : typeof t === 'string' ? new Date(t) : new Date(t * 1000);
  return d.toLocaleTimeString('en-GB', { hour12: false });
}

export function daysUntil(unixS: number, nowMs = Date.now()): number {
  return Math.max(0, Math.ceil((unixS * 1000 - nowMs) / 86_400_000));
}

/** Deterministic avatar gradient per token (palette from the designs). */
const GRADIENTS = [
  'linear-gradient(135deg,#8B5CF6,#C084FC)', 'linear-gradient(135deg,#6366F1,#A78BFA)', 'linear-gradient(135deg,#DB2777,#F472B6)',
  'linear-gradient(135deg,#0891B2,#67E8F9)', 'linear-gradient(135deg,#0EA5E9,#818CF8)', 'linear-gradient(135deg,#65A30D,#BEF264)',
  'linear-gradient(135deg,#8B5CF6,#EC4899)', 'linear-gradient(135deg,#A855F7,#F0ABFC)', 'linear-gradient(135deg,#F59E0B,#FDE68A)',
  'linear-gradient(135deg,#14B8A6,#5EEAD4)',
];
export function avatarFor(key: string): string {
  let h = 0;
  for (const c of key.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return GRADIENTS[h % GRADIENTS.length]!;
}

/** Sparkline polyline points (viewBox 0 0 100 30) from a price series. */
export function sparkPoints(series: number[]): string {
  if (series.length < 2) return '0,15 100,15';
  const lo = Math.min(...series), hi = Math.max(...series);
  const span = hi - lo || 1;
  return series.map((y, i) => `${((i / (series.length - 1)) * 100).toFixed(1)},${(27 - ((y - lo) / span) * 24).toFixed(1)}`).join(' ');
}

/** "nullsight · Ranked X-style signals…": service name if it differs from the token, else its description. */
export function serviceLabel(tokenName: string, svc: { name: string; description: string | null } | null | undefined): string {
  if (!svc) return tokenName;
  const extra = svc.name && svc.name.toLowerCase() !== tokenName.toLowerCase() ? svc.name : svc.description;
  return extra ? `${tokenName} · ${extra}` : tokenName;
}

/** Compact shape of a JSON Schema ({ field: type }), as shown on the token page. */
export function schemaShape(schemaJson: string | null): string {
  if (!schemaJson) return 'No response schema published.';
  let s: unknown;
  try { s = JSON.parse(schemaJson); } catch { return schemaJson; }
  const shape = (n: any): unknown => {
    if (!n || typeof n !== 'object') return 'any';
    if (n.const !== undefined) return String(n.const);
    if (n.enum) return n.enum.map((e: unknown) => String(e)).join(' | ');
    if (n.type === 'object' || n.properties) return Object.fromEntries(Object.entries(n.properties ?? {}).map(([k, v]) => [k, shape(v)]));
    if (n.type === 'array') return [shape(n.items)];
    if (n.format === 'date-time') return 'ISO-8601';
    return Array.isArray(n.type) ? n.type.join(' | ') : n.type ?? 'any';
  };
  return JSON.stringify(shape(s), null, 2);
}

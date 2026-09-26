/**
 * GET /api/tokens list logic: filter, search, sort, per-filter counts and paging over the full set of
 * listed tokens (so page 2 of "Revenue desc" is really rows 26–50 of that ranking, not a re-sort of one
 * DB page). Pure: the route builds the rows, this decides which ones and in what order.
 * Numbers are compared as display values (Number of the decimal strings); no money math happens here.
 */
import { z } from 'zod';

export const TOKEN_FILTERS = ['with-revenue', 'verified', 'new', 'high-ucr', 'no-service'] as const;
export type TokenFilter = typeof TOKEN_FILTERS[number];
export const TOKEN_SORTS = ['revenue', 'price', 'change24h', 'mcap', 'ucr', 'calls', 'new'] as const;
export type TokenSort = typeof TOKEN_SORTS[number];

/** "New" filter window. */
export const NEW_TOKEN_WINDOW_MS = 7 * 86_400_000;
/** "High UCR" threshold (usage ≥ trading). */
export const HIGH_UCR = 1;

/** Query params of GET /api/tokens. `sort=clean_revenue_30d` (legacy) = revenue desc. */
export const tokenListQuerySchema = z.object({
  filter: z.enum(['all', ...TOKEN_FILTERS]).default('all'),
  sort:   z.enum([...TOKEN_SORTS, 'clean_revenue_30d']).default('revenue')
    .transform((s): TokenSort => (s === 'clean_revenue_30d' ? 'revenue' : s)),
  dir:    z.enum(['asc', 'desc']).default('desc'),
  q:      z.string().trim().max(64).default(''),
  limit:  z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  days:   z.coerce.number().refine((d) => d === 7 || d === 30 || d === 90, 'days must be 7, 30 or 90').default(30),
});
export type TokenListQuery = z.infer<typeof tokenListQuerySchema>;

/** The fields of a token summary the list logic reads. */
export interface ListRow {
  asset: string; name: string; symbol: string; creator: string; xHandle: string | null; launchedAt: Date | string;
  verified: boolean;
  service: { name: string } | null;
  market: { priceUsd: string | null; change24hBps: number | null; mcapUsd: string | null } | null;
  usage30d: { cleanRevenueUsdc: string; ucr: string | null; paidCalls: number } | null;
}

const num = (v: string | number | null | undefined): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const launchedMs = (r: ListRow) => new Date(r.launchedAt).getTime();
const revenue = (r: ListRow) => num(r.usage30d?.cleanRevenueUsdc) ?? 0;

export function matchesFilter(r: ListRow, f: TokenFilter, nowMs: number): boolean {
  switch (f) {
    case 'with-revenue': return revenue(r) > 0;
    case 'verified':     return r.verified;
    case 'new':          return nowMs - launchedMs(r) < NEW_TOKEN_WINDOW_MS;
    case 'high-ucr':     return (num(r.usage30d?.ucr) ?? 0) >= HIGH_UCR;
    case 'no-service':   return r.service === null;
  }
}

export function matchesSearch(r: ListRow, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return [r.symbol, r.name, r.service?.name, r.creator, r.xHandle, r.asset].some((x) => x?.toLowerCase().includes(s));
}

function sortValue(r: ListRow, s: TokenSort): number | null {
  switch (s) {
    case 'revenue':   return revenue(r);
    case 'price':     return num(r.market?.priceUsd);
    case 'change24h': return r.market?.change24hBps ?? null;
    case 'mcap':      return num(r.market?.mcapUsd);
    case 'ucr':       return num(r.usage30d?.ucr);
    case 'calls':     return r.usage30d?.paidCalls ?? null;
    case 'new':       return launchedMs(r);
  }
}

/** Sort in `dir`, missing values always last; ties: newest first, then asset (stable across pages). */
export function compareRows(a: ListRow, b: ListRow, s: TokenSort, dir: 'asc' | 'desc'): number {
  const va = sortValue(a, s), vb = sortValue(b, s);
  if (va !== vb) {
    if (va === null) return 1;
    if (vb === null) return -1;
    return dir === 'asc' ? va - vb : vb - va;
  }
  return launchedMs(b) - launchedMs(a) || a.asset.localeCompare(b.asset);
}

export type FilterCounts = Record<'all' | TokenFilter, number>;

export interface TokenListResult<T> { tokens: T[]; total: number; counts: FilterCounts }

/** Search → counts per filter → active filter → sort → page. */
export function listTokens<T extends ListRow>(rows: T[], q: Pick<TokenListQuery, 'filter' | 'sort' | 'dir' | 'q' | 'limit' | 'offset'>, nowMs: number): TokenListResult<T> {
  const searched = rows.filter((r) => matchesSearch(r, q.q));
  const counts = { all: searched.length } as FilterCounts;
  for (const f of TOKEN_FILTERS) counts[f] = searched.filter((r) => matchesFilter(r, f, nowMs)).length;
  const filtered = q.filter === 'all' ? searched : searched.filter((r) => matchesFilter(r, q.filter as TokenFilter, nowMs));
  const sorted = [...filtered].sort((a, b) => compareRows(a, b, q.sort, q.dir));
  return { tokens: sorted.slice(q.offset, q.offset + q.limit), total: filtered.length, counts };
}

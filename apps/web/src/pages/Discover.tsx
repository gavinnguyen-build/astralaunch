/**
 * /discover — docs/design/Discover.dc.html with real data. Filter, range, sort, search and page live in the URL
 * (?filter=&range=&sort=&dir=&q=&page=) so Back and refresh keep them; the server filters, sorts and pages
 * (GET /api/tokens), 25 rows per page.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { DiscoverView } from '../design/DiscoverView.js';
import { api, TOKEN_FILTERS, type TokenFilter, type TokenSort } from '../lib/api.js';
import { avatarFor, compact, fmtBps, fmtPrice, fmtUsdc, isDown, serviceLabel, sparkPoints } from '../lib/format.js';
import { Empty, ErrorBox, Loading, UsdOr } from '../components/State.js';
import { chipLabel, ucrBits } from './Home.js';
import { pageItems } from '../lib/pagination.js';

const GREEN = '#34D399', RED = '#F87171', MUTED = '#8C87A3', INK = '#ECEAF4', PURPLE = '#8B5CF6';
export const PAGE_SIZE = 25;
const RANGES = [['7D', '7d', 7], ['30D', '30d', 30], ['90D', '90d', 90]] as const;
type Range = typeof RANGES[number][1];
const SORTABLE: { key: TokenSort; label: string }[] = [
  { key: 'price', label: 'PRICE' }, { key: 'change24h', label: '24H' }, { key: 'mcap', label: 'MCAP' },
  { key: 'revenue', label: 'REVENUE' }, { key: 'ucr', label: 'UCR' }, { key: 'calls', label: 'CALLS' },
];
const DEFAULTS = { filter: 'with-revenue' as TokenFilter, range: '30d' as Range, sort: 'revenue' as TokenSort, dir: 'desc' as 'asc' | 'desc' };

/** URL → view state; anything unknown falls back to the default. */
function readParams(sp: URLSearchParams) {
  const pick = <T extends string>(k: string, allowed: readonly T[], d: T): T => (allowed as readonly string[]).includes(sp.get(k) ?? '') ? (sp.get(k) as T) : d;
  const page = Math.max(1, Math.floor(Number(sp.get('page')) || 1));
  return {
    filter: pick('filter', TOKEN_FILTERS.map((f) => f.slug), DEFAULTS.filter),
    range: pick('range', RANGES.map((r) => r[1]), DEFAULTS.range),
    sort: pick('sort', SORTABLE.map((s) => s.key), DEFAULTS.sort),
    dir: pick('dir', ['asc', 'desc'] as const, DEFAULTS.dir),
    q: (sp.get('q') ?? '').slice(0, 64),
    page,
  };
}
type State = ReturnType<typeof readParams>;

export default function Discover() {
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const st = readParams(sp);
  const days = RANGES.find((r) => r[1] === st.range)![2];

  /** Write state to the URL. Changing filter / range / sort / search goes back to page 1. */
  const update = (patch: Partial<State>, opts: { replace?: boolean } = {}) => {
    const next: State = { ...st, ...patch };
    if (('filter' in patch && patch.filter !== st.filter) || ('range' in patch && patch.range !== st.range)
      || ('sort' in patch && (patch.sort !== st.sort || patch.dir !== st.dir)) || ('q' in patch && patch.q !== st.q)) next.page = 1;
    const qs = new URLSearchParams({ filter: next.filter, range: next.range, sort: next.sort, dir: next.dir });
    if (next.q) qs.set('q', next.q);
    if (next.page > 1) qs.set('page', String(next.page));
    navigate({ search: `?${qs}` }, { replace: opts.replace });
  };

  // Search box: local text, pushed to the URL after a short pause (replace, so each keystroke is not a Back step).
  const [text, setText] = useState(st.q);
  useEffect(() => { setText(st.q); }, [st.q]);
  useEffect(() => {
    if (text.trim() === st.q) return;
    const id = setTimeout(() => update({ q: text.trim() }, { replace: true }), 300);
    return () => clearTimeout(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const offset = (st.page - 1) * PAGE_SIZE;
  const list = useQuery({
    queryKey: ['tokenList', 'discover', st.filter, st.sort, st.dir, st.q, days, st.page],
    queryFn: () => api.tokenList({ filter: st.filter, sort: st.sort, dir: st.dir, q: st.q || undefined, limit: PAGE_SIZE, offset, days }),
    placeholderData: (prev) => prev,
  });
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // A page past the end (e.g. an old link) goes to the last page.
  useEffect(() => {
    if (list.data && !list.isPlaceholderData && total > 0 && st.page > pages) update({ page: pages }, { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data, list.isPlaceholderData, total, pages, st.page]);

  const rows = (list.data?.tokens ?? []).map((t, i) => {
    const chg = t.market?.change24hBps ?? null;
    const sym = t.market?.numeraireSymbol ?? 'USDC';
    return {
      rank: String(offset + i + 1), initial: t.symbol.charAt(0), avatar: avatarFor(t.asset), sym: `$${t.symbol}`,
      name: serviceLabel(t.name, t.service),
      price: <UsdOr usd={t.market?.priceUsd} alt={t.market?.price ? fmtPrice(t.market.price, '') : null} symbol={sym} price />,
      chg: fmtBps(chg), chgColor: isDown(chg) ? RED : GREEN,
      mcap: <UsdOr usd={t.market?.mcapUsd} alt={t.market?.price && t.market.supply ? compact(Number(t.market.price) * Number(t.market.supply)) : null} symbol={sym} />,
      rev: fmtUsdc(t.usage30d?.cleanRevenueUsdc ?? '0'), calls: compact(t.usage30d?.paidCalls ?? 0),
      spark: sparkPoints(t.market?.spark7d ?? []),
      href: `/token/${t.asset}`,
      ...ucrBits(t.usage30d?.ucr),
    };
  });

  const filterLabel = TOKEN_FILTERS.find((f) => f.slug === st.filter)!.label;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);
  const pageBtn = (on: boolean) => ({ bg: on ? PURPLE : 'transparent', fg: on ? '#FFFFFF' : '#C9C5DA', border: on ? '0' : '1px solid #2A2640' });

  const v = {
    range: RANGES.find((r) => r[1] === st.range)![0],
    ranges: RANGES.map(([label, id]) => {
      const on = id === st.range;
      return { label, on: on ? 'true' : 'false', bg: on ? '#2A2640' : 'transparent', fg: on ? INK : MUTED, pick: () => update({ range: id }) };
    }),
    filters: TOKEN_FILTERS.map((f) => {
      const on = f.slug === st.filter;
      return { label: chipLabel(f.label, list.data?.counts[f.slug]), pressed: on ? 'true' : 'false', bg: on ? PURPLE : 'transparent', fg: on ? '#FFFFFF' : '#C9C5DA', border: on ? '0' : '1px solid #2A2640', pick: () => update({ filter: f.slug }) };
    }),
    cols: Object.fromEntries(SORTABLE.map((c) => {
      const on = c.key === st.sort;
      return [c.key, {
        label: c.key === 'revenue' ? `${c.label} ${RANGES.find((r) => r[1] === st.range)![0]}` : c.label,
        arrow: on ? (st.dir === 'desc' ? '▼' : '▲') : '',
        ariaSort: on ? (st.dir === 'desc' ? 'descending' : 'ascending') : 'none',
        color: on ? INK : MUTED,
        pick: () => update({ sort: c.key, dir: on ? (st.dir === 'desc' ? 'asc' : 'desc') : 'desc' }),
      }];
    })),
    rows,
    showing: total === 0 ? `Showing 0 of 0 tokens` : `Showing ${from}–${to} of ${total.toLocaleString('en-US')} tokens`,
    pages: pageItems(Math.min(st.page, pages), pages).map((p, i) => p === '…'
      ? { key: `gap${i}`, label: '…', gap: true }
      : { key: `p${p}`, label: String(p), gap: false, current: p === st.page ? 'page' : undefined, ...pageBtn(p === st.page), pick: () => update({ page: p }) }),
    prevDisabled: st.page <= 1, nextDisabled: st.page >= pages,
    prev: () => update({ page: Math.max(1, st.page - 1) }), next: () => update({ page: Math.min(pages, st.page + 1) }),
    query: text, onQuery: (e: React.ChangeEvent<HTMLInputElement>) => setText(e.target.value),
    rowsState: list.isLoading ? <div style={{ padding: '10px 0' }}><Loading rows={4} /></div>
      : list.error ? <div style={{ padding: '10px 0' }}><ErrorBox error={list.error} retry={() => list.refetch()} /></div>
      : rows.length === 0 ? <div style={{ padding: '10px 0' }}><Empty>{st.q ? `No tokens under "${filterLabel}" match "${st.q}".` : `No tokens under "${filterLabel}".`}</Empty></div> : null,
  };
  return <DiscoverView v={v} />;
}

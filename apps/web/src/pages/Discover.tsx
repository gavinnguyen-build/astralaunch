/** /discover — docs/design/Discover.dc.html with real data. */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DiscoverView } from '../design/DiscoverView.js';
import { api } from '../lib/api.js';
import { avatarFor, compact, fmtBps, fmtUsdc, isDown, serviceLabel, sparkPoints } from '../lib/format.js';
import { Empty, ErrorBox, Loading, UsdOr } from '../components/State.js';
import { FILTERS, applyFilter, ucrBits, type Filter } from './Home.js';

const GREEN = '#34D399', RED = '#F87171', MUTED = '#8C87A3', INK = '#ECEAF4';
const RANGES = [['7D', 7], ['30D', 30], ['90D', 90]] as const;

export default function Discover() {
  const [filter, setFilter] = useState<Filter>('With revenue');
  const [range, setRange] = useState<typeof RANGES[number][0]>('30D');
  const [query, setQuery] = useState('');
  const days = RANGES.find((r) => r[0] === range)![1];
  const tokens = useQuery({ queryKey: ['tokens', days], queryFn: () => api.tokens(days) });
  const all = tokens.data?.tokens ?? [];

  const rows = useMemo(() => applyFilter(all, filter, query).map((t, i) => {
    const chg = t.market?.change24hBps ?? null;
    const sym = t.market?.numeraireSymbol ?? 'USDC';
    return {
      rank: String(i + 1), initial: t.symbol.charAt(0), avatar: avatarFor(t.asset), sym: `$${t.symbol}`,
      name: serviceLabel(t.name, t.service),
      price: <UsdOr usd={t.market?.priceUsd} alt={t.market?.price ? compact(t.market.price) : null} symbol={sym} />,
      chg: fmtBps(chg), chgColor: isDown(chg) ? RED : GREEN,
      mcap: <UsdOr usd={t.market?.mcapUsd} alt={t.market?.price && t.market.supply ? compact(Number(t.market.price) * Number(t.market.supply)) : null} symbol={sym} />,
      rev: fmtUsdc(t.usage30d?.cleanRevenueUsdc ?? '0'), calls: compact(t.usage30d?.paidCalls ?? 0),
      spark: sparkPoints(t.market?.spark7d ?? []),
      href: `/token/${t.asset}`,
      ...ucrBits(t.usage30d?.ucr),
    };
  }), [all, filter, query]);

  const v = {
    range,
    ranges: RANGES.map(([r]) => {
      const on = r === range;
      return { label: r, on: on ? 'true' : 'false', bg: on ? '#2A2640' : 'transparent', fg: on ? INK : MUTED, pick: () => setRange(r) };
    }),
    filters: FILTERS.map((l) => {
      const on = l === filter;
      return { label: l, pressed: on ? 'true' : 'false', bg: on ? '#8B5CF6' : 'transparent', fg: on ? '#FFFFFF' : '#C9C5DA', border: on ? '0' : '1px solid #2A2640', pick: () => setFilter(l) };
    }),
    rows, shown: rows.length, total: all.length,
    query, onQuery: (e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value),
    rowsState: tokens.isLoading ? <div style={{ padding: '10px 0' }}><Loading rows={4} /></div>
      : tokens.error ? <div style={{ padding: '10px 0' }}><ErrorBox error={tokens.error} retry={() => tokens.refetch()} /></div>
      : rows.length === 0 ? <div style={{ padding: '10px 0' }}><Empty>{query ? 'No token matches your search.' : `No tokens under "${filter}".`}</Empty></div> : null,
  };
  return <DiscoverView v={v} />;
}

/** / — docs/design/Home.dc.html with real data (stats, services ranked by clean revenue 30d). */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { HomeView } from '../design/HomeView.js';
import { api, type TokenListItem } from '../lib/api.js';
import { ago, avatarFor, compact, fmtBps, fmtUsdc, isDown } from '../lib/format.js';
import { ErrorBox, Loading, Empty } from '../components/State.js';
import { AddrLink } from '../components/Explorer.js';

const GREEN = '#34D399', RED = '#F87171', MUTED = '#8C87A3';
export const FILTERS = ['With revenue', 'Verified', 'New', 'High UCR', 'No service yet'] as const;
export type Filter = typeof FILTERS[number];

/** Filter + sort shared by Home and Discover (SPEC §14: default = clean revenue 30d). */
export function applyFilter(list: TokenListItem[], filter: Filter, query: string): TokenListItem[] {
  const q = query.trim().toLowerCase();
  const rev = (t: TokenListItem) => Number(t.usage30d?.cleanRevenueUsdc ?? 0);
  const ucr = (t: TokenListItem) => (t.usage30d?.ucr == null ? null : Number(t.usage30d.ucr));
  let out = list.filter((t) => !q || [t.symbol, t.name, t.service?.name, t.creator, t.xHandle].some((x) => x?.toLowerCase().includes(q)));
  if (filter === 'With revenue') out = out.filter((t) => rev(t) > 0).sort((a, b) => rev(b) - rev(a));
  if (filter === 'Verified') out = out.filter((t) => t.verified).sort((a, b) => rev(b) - rev(a));
  if (filter === 'New') out = out.filter((t) => Date.now() - Date.parse(t.launchedAt) < 7 * 86_400_000).sort((a, b) => Date.parse(b.launchedAt) - Date.parse(a.launchedAt));
  if (filter === 'High UCR') out = out.filter((t) => (ucr(t) ?? 0) >= 1).sort((a, b) => (ucr(b) ?? 0) - (ucr(a) ?? 0));
  if (filter === 'No service yet') out = out.filter((t) => !t.service);
  return out;
}

export function ucrBits(u: string | null | undefined) {
  const n = u == null ? null : Number(u);
  const over = n != null && n >= 1;
  return {
    ucr: n == null ? '—' : n.toFixed(2),
    ucrW: `${n == null ? 3 : Math.max(3, Math.min(100, Math.round((n / 2) * 100)))}%`,
    ucrBar: over ? 'linear-gradient(90deg,#34D399,#6EE7B7)' : 'linear-gradient(90deg,#8B5CF6,#C4B5FD)',
    ucrColor: over ? GREEN : MUTED,
  };
}

export default function Home() {
  const [filter, setFilter] = useState<Filter>('With revenue');
  const [query, setQuery] = useState('');
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats });
  const tokens = useQuery({ queryKey: ['tokens', 30], queryFn: () => api.tokens(30) });

  const cards = useMemo(() => applyFilter(tokens.data?.tokens ?? [], filter, query).map((t) => {
    const chg = t.market?.change7dBps ?? null;
    const handle = t.xHandle ? `@${t.xHandle}` : `${t.creator.slice(0, 6)}…${t.creator.slice(-4)}`;
    return {
      initial: (t.service?.name ?? t.name).charAt(0).toUpperCase(), avatar: avatarFor(t.asset),
      name: t.service?.name ?? t.name, handle, verified: t.verified,
      desc: t.service?.description ?? t.description ?? 'No service yet.',
      symbol: `$${t.symbol}`, price: t.service ? `${fmtUsdc(Number(t.service.priceUsdc) / 1e6)} USDC` : '—',
      rev: fmtUsdc(t.usage30d?.cleanRevenueUsdc ?? '0'), chg: `${fmtBps(chg)} 7d`, chgColor: isDown(chg) ? RED : GREEN,
      calls: compact(t.usage30d?.paidCalls ?? 0), by: <AddrLink a={t.creator} label={handle} />, age: ago(t.launchedAt),
      href: `/token/${t.asset}`, chartHref: `/token/${t.asset}/chart`, tryHref: `/token/${t.asset}#service`, hasService: !!t.service,
      ...ucrBits(t.usage30d?.ucr),
    };
  }), [tokens.data, filter, query]);

  const v = {
    stats: {
      servicesLive: stats.data ? stats.data.servicesLive.toLocaleString('en-US') : '—',
      paidCalls: stats.data ? stats.data.paidCalls.toLocaleString('en-US') : '—',
      paidToProviders: stats.data ? fmtUsdc(stats.data.paidToProvidersUsdc) : '—',
    },
    filters: FILTERS.map((l) => {
      const on = l === filter;
      return { label: l, pressed: on ? 'true' : 'false', bg: on ? '#8B5CF6' : 'transparent', fg: on ? '#FFFFFF' : '#C9C5DA',
        border: on ? '0' : '1px solid #2A2640', pick: () => setFilter(l) };
    }),
    cards,
    query, onQuery: (e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value),
    cardsState: tokens.isLoading ? <Loading rows={2} height={120} />
      : tokens.error ? <ErrorBox error={tokens.error} retry={() => tokens.refetch()} />
      : cards.length === 0 ? <Empty>{query ? 'No service matches your search.' : `No services under "${filter}" yet.`}</Empty> : null,
    steps: [
      { icon: '01', n: '01', title: 'Bring an API', body: 'Paste your endpoint and set a price per call. The gateway handles x402 payment and only charges when your API answers.' },
      { icon: '02', n: '02', title: 'Launch the token', body: 'One transaction creates the token and its pool on Monad. Real users get a fair first 12 minutes.' },
      { icon: '03', n: '03', title: 'Usage pays holders', body: 'Every paid call splits 60 / 30 / 10. The 30% buys back and burns the token, onchain and verifiable.' },
    ],
  };
  return <HomeView v={v} />;
}

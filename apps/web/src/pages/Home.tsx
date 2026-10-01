/** / — docs/design/Home.dc.html with real data (stats, the top 9 services by clean revenue 30d per filter). */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { HomeView } from '../design/HomeView.js';
import { api, TOKEN_FILTERS, type TokenFilter } from '../lib/api.js';
import { avatarFor, fmtUsd, fmtUsdc } from '../lib/format.js';
import { ErrorBox, Loading, Empty } from '../components/State.js';

const GREEN = '#34D399', MUTED = '#8C87A3';
/** Cards on Home (3 × 3). */
export const HOME_CARDS = 9;

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

/** Chip label with its count once known: "With revenue · 64". */
export const chipLabel = (label: string, count: number | undefined) => (count === undefined ? label : `${label} · ${count.toLocaleString('en-US')}`);

export default function Home() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<TokenFilter>('with-revenue');
  const [query, setQuery] = useState('');
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats });
  const list = useQuery({
    queryKey: ['tokenList', 'home', filter],
    queryFn: () => api.tokenList({ filter, sort: 'revenue', dir: 'desc', limit: HOME_CARDS, days: 30 }),
    placeholderData: (prev) => prev,
  });
  const label = TOKEN_FILTERS.find((f) => f.slug === filter)!.label;
  // Service cards: image, name, $TICKER (copy address), chain, 2-line description, Market cap, Volume 24h.
  const cards = (list.data?.tokens ?? []).map((t) => {
    const name = t.service?.name ?? t.name;
    return {
      href: `/token/${t.asset}`, asset: t.asset, name, ticker: `$${t.symbol}`,
      imageUrl: t.imageUrl, initial: name.charAt(0).toUpperCase(),
      // solid tile: the first colour of the token's avatar gradient
      tile: avatarFor(t.asset).match(/#[0-9A-Fa-f]{6}/)?.[0] ?? '#8B5CF6',
      desc: t.service?.description ?? t.description ?? 'No description yet.',
      mcap: t.market?.mcapUsd != null ? fmtUsd(t.market.mcapUsd) : '—',
      vol24: t.market?.volume24hUsd != null ? fmtUsd(t.market.volume24hUsd) : '—',
    };
  });

  const v = {
    stats: {
      servicesLive: stats.data ? stats.data.servicesLive.toLocaleString('en-US') : '—',
      paidCalls: stats.data ? stats.data.paidCalls.toLocaleString('en-US') : '—',
      paidToProviders: stats.data ? fmtUsdc(stats.data.paidToProvidersUsdc) : '—',
    },
    filters: TOKEN_FILTERS.map((f) => {
      const on = f.slug === filter;
      return { label: chipLabel(f.label, list.data?.counts[f.slug]), pressed: on ? 'true' : 'false', bg: on ? '#8B5CF6' : 'transparent', fg: on ? '#FFFFFF' : '#C9C5DA',
        border: on ? '0' : '1px solid #2A2640', pick: () => setFilter(f.slug) };
    }),
    cards,
    moreHref: `/discover?filter=${filter}`,
    query, onQuery: (e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value),
    onSearch: (e: React.FormEvent) => {
      e.preventDefault();
      const q = query.trim();
      navigate(q ? `/discover?q=${encodeURIComponent(q)}` : '/discover');
    },
    cardsState: list.isLoading ? <Loading rows={2} height={120} />
      : list.error ? <ErrorBox error={list.error} retry={() => list.refetch()} />
      : cards.length === 0 ? <Empty>{`No services under "${label}" yet.`}</Empty> : null,
    steps: [
      { icon: '01', n: '01', title: 'Bring an API', body: 'Paste your endpoint and set a price per call. The gateway handles x402 payment and only charges when your API answers.' },
      { icon: '02', n: '02', title: 'Launch the token', body: 'One transaction creates the token and its pool on Monad. Real users get a fair first 12 minutes.' },
      { icon: '03', n: '03', title: 'Usage pays holders', body: 'Every paid call splits 60 / 30 / 10. The 30% buys back and burns the token, onchain and verifiable.' },
    ],
  };
  return <HomeView v={v} />;
}

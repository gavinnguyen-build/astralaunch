/** /leaderboard — docs/design/Leaderboard.dc.html. Creators: real API. Traders: coming soon. */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LeaderboardView } from '../design/LeaderboardView.js';
import { api, type LeaderCreator } from '../lib/api.js';
import { avatarFor, compact, fmtUsdc, shortAddr } from '../lib/format.js';
import { Empty, ErrorBox, Loading } from '../components/State.js';
import { useWalletAddress } from '../components/Site.js';
import { AddrLink } from '../components/Explorer.js';

const GREEN = '#34D399', INK = '#ECEAF4', MUTED = '#8C87A3';
const PERIODS = [['7D', '7d'], ['30D', '30d'], ['All', 'all']] as const;
type Sort = 'rev' | 'ucr' | 'calls';

export default function Leaderboard() {
  const [group, setGroup] = useState<'creators' | 'traders'>('creators');
  const [period, setPeriod] = useState<typeof PERIODS[number][0]>('30D');
  const [sort, setSort] = useState<Sort>('rev');
  const wallet = useWalletAddress()?.toLowerCase() ?? null;
  const apiPeriod = PERIODS.find((p) => p[0] === period)![1];
  const q = useQuery({ queryKey: ['leaderboard', apiPeriod], queryFn: () => api.leaderboard(apiPeriod) });
  const isC = group === 'creators';

  const val = (c: LeaderCreator) => (sort === 'rev' ? Number(c.cleanRevenueUsdc) : sort === 'ucr' ? Number(c.bestUcr ?? -1) : c.paidCalls);
  const list = isC ? [...(q.data?.creators ?? [])].sort((a, b) => val(b) - val(a)) : [];
  const ucr = (c: LeaderCreator) => (c.bestUcr == null ? '—' : Number(c.bestUcr).toFixed(2));
  const name = (c: LeaderCreator) => shortAddr(c.creator);
  const sub = (c: LeaderCreator) => c.tokens.map((t) => `$${t.symbol}`).join(', ');
  const href = (c: LeaderCreator) => `/token/${c.tokens[0]?.asset ?? ''}`;
  const cells = (c: LeaderCreator) => [
    { v: String(c.tokens.length), color: INK }, { v: `${fmtUsdc(c.cleanRevenueUsdc)} USDC`, color: INK },
    { v: compact(c.paidCalls), color: INK }, { v: ucr(c), color: c.bestUcr != null && Number(c.bestUcr) >= 1 ? GREEN : MUTED },
    { v: String(c.holders), color: INK },
  ];
  const tint = ['#FDE68A', '#E5E7EB', '#F4B183'];
  const meIdx = wallet ? list.findIndex((c) => c.creator === wallet) : -1;

  const v = {
    subtitle: isC ? 'Creators ranked by what agents actually pay for.' : 'Traders ranked by results on Astralaunch pools.',
    periods: PERIODS.map(([p]) => ({ label: p, on: String(p === period), bg: p === period ? '#2A2640' : 'transparent', fg: p === period ? INK : MUTED, pick: () => setPeriod(p) })),
    groups: ([['creators', 'Creators', isC || q.data ? String(q.data?.creators.length ?? '—') : '—'], ['traders', 'Traders', '—']] as const).map(([k, label, count]) => {
      const on = k === group;
      return { label, count, on: String(on), bg: on ? '#8B5CF6' : 'transparent', fg: on ? '#FFFFFF' : '#C9C5DA', countBg: on ? 'rgba(255,255,255,0.18)' : '#221F33', countFg: on ? '#FFFFFF' : MUTED, pick: () => setGroup(k) };
    }),
    sorts: (isC ? [['rev', 'Clean revenue'], ['ucr', 'Usage coverage'], ['calls', 'Paid calls']] : [['pnl', 'Realized PnL'], ['vol', 'Volume'], ['win', 'Win rate']]).map(([k, label]) => {
      const on = isC ? k === sort : k === 'pnl';
      return { label, on: String(on), bg: on ? '#2A2640' : 'transparent', fg: on ? INK : '#C9C5DA', border: on ? '1px solid #3A3456' : '1px solid #25213A', pick: () => isC && setSort(k as Sort) };
    }),
    podium: list.slice(0, 3).map((c, i) => ({
      rank: i + 1, name: name(c), sub: sub(c), initial: c.tokens[0]?.symbol.charAt(0) ?? '?', avatar: avatarFor(c.creator), href: href(c),
      metricLabel: { rev: 'Clean revenue', ucr: 'Best UCR', calls: 'Paid calls' }[sort],
      metric: { rev: `${fmtUsdc(c.cleanRevenueUsdc)} USDC`, ucr: c.bestUcr == null ? '—' : `${Number(c.bestUcr).toFixed(2)}×`, calls: compact(c.paidCalls) }[sort],
      metricColor: i === 0 ? GREEN : INK,
      facts: [{ k: 'Tokens', v: String(c.tokens.length) }, { k: 'Holders', v: String(c.holders) }, { k: 'UCR', v: ucr(c) }],
      border: i === 0 ? '1px solid #8B5CF6' : '1px solid #25213A', bg: i === 0 ? '#1B1530' : '#13111C', rankBg: tint[i], rankFg: '#1A1530',
    })),
    cols: '56px 240px repeat(5, minmax(0,1fr))',
    heads: (isC
      ? [['#', 'left'], ['Creator', 'left'], ['Tokens', 'right'], ['Clean revenue', 'right'], ['Paid calls', 'right'], ['Best UCR', 'right'], ['Holders', 'right']]
      : [['#', 'left'], ['Trader', 'left'], ['Volume', 'right'], ['Realized PnL', 'right'], ['Win rate', 'right'], ['Trades', 'right'], ['Best trade', 'right']]
    ).map(([label, align]) => ({ label, align })),
    rows: list.slice(3).map((c, i) => ({ rank: String(i + 4), name: name(c), sub: sub(c), initial: c.tokens[0]?.symbol.charAt(0) ?? '?', avatar: avatarFor(c.creator), href: href(c), bg: 'transparent', cells: cells(c) })),
    me: isC && wallet ? {
      rank: meIdx >= 0 ? `#${meIdx + 1}` : '—', addr: <AddrLink a={wallet} />,
      sub: meIdx >= 0 ? sub(list[meIdx]!) : 'No listed tokens yet',
      cells: meIdx >= 0 ? cells(list[meIdx]!) : [{ v: '0', color: INK }, { v: '0 USDC', color: INK }, { v: '0', color: INK }, { v: '—', color: MUTED }, { v: '0', color: INK }],
    } : null,
    listState: !isC ? <Empty>Trader rankings are coming soon. They will rank realized PnL on Astralaunch pools, excluding creators, fee recipients, platform contracts and buyback swaps.</Empty>
      : q.isLoading ? <Loading rows={3} height={120} />
      : q.error ? <ErrorBox error={q.error} retry={() => q.refetch()} />
      : list.length === 0 ? <Empty>No creators with listed tokens yet.</Empty> : null,
  };
  return <LeaderboardView v={v} />;
}

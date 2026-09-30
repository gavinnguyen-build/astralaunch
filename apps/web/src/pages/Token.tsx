/** /token/:asset — docs/design/Token.dc.html (Info) with real data. */
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { TokenView } from '../design/TokenView.js';
import { api, type TokenDetail } from '../lib/api.js';
import { ago, avatarFor, compact, daysUntil, fmtDate, fmtTime, fmtUsd, fmtUsdc, schemaShape, fmtPrice } from '../lib/format.js';
import { Empty, ErrorBox, Loading, UsdOr } from '../components/State.js';
import { SiteFooter, SiteHeader } from '../components/Site.js';
import { AddrLink, TokenLink, TxLink } from '../components/Explorer.js';
import { SampleCall, agentLink, priceLabel, sampleRequestText } from '../components/SampleCall.js';
import { PRIVY_ENABLED, useConnectedWallet, useLogin } from '../components/Site.js';
import { get } from '../lib/api.js';
import type { ChainConfig } from '../lib/launch.js';
import { useState } from 'react';

const GREEN = '#34D399', RED = '#F87171', MUTED = '#8C87A3';
const TAGS = {
  clean: ['Clean revenue', GREEN], creator: ['Excluded · creator', RED],
  contract: ['Excluded · platform contract', RED], not_facilitator: ['Excluded · not settled by facilitator', MUTED],
} as const;

export function PageShell({ children, active = '' }: { children: React.ReactNode; active?: string }) {
  return (
    <div style={{ width: '1440px', minHeight: '900px', background: '#0B0A12', color: '#ECEAF4', display: 'flex', flexDirection: 'column' }}>
      <SiteHeader active={active} />
      <main style={{ padding: '40px 124px' }}>{children}</main>
      <SiteFooter />
    </div>
  );
}

function pct(a: number, b: number) { return `${b > 0 ? Math.max(0, Math.min(100, (a / b) * 100)).toFixed(1) : 0}%`; }

export default function Token() {
  const { asset = '' } = useParams();
  const token = useQuery({ queryKey: ['token', asset], queryFn: () => api.token(asset) });
  const payments = useQuery({ queryKey: ['payments', asset], queryFn: () => api.payments(asset), enabled: !!token.data });
  const wallet = useConnectedWallet();
  const login = useLogin();
  const cfg = useQuery({ queryKey: ['config'], queryFn: () => get<ChainConfig>('/api/config') });
  const [trying, setTrying] = useState(false);

  if (token.isLoading) return <PageShell><Loading rows={6} height={60} /></PageShell>;
  if (token.error) {
    return <PageShell>{/Token not found/.test(String(token.error)) ? <Empty>This token is not listed on Astralaunch.</Empty>
      : <ErrorBox error={token.error} retry={() => token.refetch()} />}</PageShell>;
  }
  const t = token.data as TokenDetail;
  const m = t.market;
  const sym = m?.numeraireSymbol ?? 'USDC';
  const u = t.usage30d;
  const svc = t.service;
  const priceUsdc = svc ? fmtUsdc(Number(svc.priceUsdc) / 1e6) : null;
  const ucr = u?.ucr == null ? null : Number(u.ucr);
  const bbRev = Number(t.onChain.buyback?.buybackFromRevenue ?? 0) / 1e6;
  const bbTrd = Number(t.onChain.buyback?.buybackFromTrading ?? 0) / 1e6;
  const bbMax = Math.max(bbRev, bbTrd);
  const esc = t.creatorSummary.escrow;
  const vest = t.creatorSummary.vesting;
  const unlocked = esc ? Math.min(Number(esc.usdcAccrued), (Number(esc.recordedRevenue) * 0.2)) : 0;
  const health = t.serviceHealth;

  const v = {
    initial: t.symbol.charAt(0), avatar: avatarFor(t.asset), sym: `$${t.symbol}`, name: t.name,
    infoHref: `/token/${t.asset}`, chartHref: `/token/${t.asset}/chart`,
    title: svc?.name ?? t.name, verified: t.verified,
    desc: svc?.description ?? t.description ?? 'This token has no service description yet.',
    creatorLabel: <AddrLink a={t.creator} />, xHandle: t.xHandle ? `@${t.xHandle}` : null, xHref: t.xHandle ? `https://x.com/${t.xHandle}` : '#',
    website: t.website, websiteLabel: t.website?.replace(/^https?:\/\//, '').replace(/\/$/, ''),
    launched: `${fmtDate(t.launchedAt)} · ${ago(t.launchedAt)} ago`,
    tokenShort: <TokenLink a={t.asset} />, tokenFull: t.asset, routerShort: <AddrLink a={t.router} />, routerFull: t.router,
    poolLabel: `${t.symbol} / ${sym} · 2%`, feeRecipient: <AddrLink a={t.creator} />,
    price: <UsdOr usd={m?.priceUsd} alt={m?.price ? fmtPrice(m.price, '') : null} symbol={sym} price />,
    mcap: <UsdOr usd={m?.mcapUsd} alt={m?.price ? compact(Number(m.price) * Number(m.supply)) : null} symbol={sym} />,
    vol24: <UsdOr usd={m?.volume24hUsd} alt={m ? compact(m.volume24h) : null} symbol={sym} />,
    holders: t.holders.toLocaleString('en-US'),
    ucrBig: ucr == null ? 'n/a' : `${ucr.toFixed(2)}×`,
    ucrText: ucr == null
      ? 'No trading volume in the last 30 days yet, so there is nothing to compare usage against. Above 1.0, the token is backed by usage more than by volume.'
      : `Paying agents funded ${ucr.toFixed(2)} times ${ucr >= 1 ? 'more' : 'as much'} buyback than trading did. Above 1.0, the token is backed by usage more than by volume.`,
    bbUsage: fmtUsd(bbRev), bbTrading: fmtUsd(bbTrd), bbUsageW: pct(bbRev, bbMax), bbTradingW: pct(bbTrd, bbMax),
    stats: [
      { label: 'CLEAN REVENUE', value: `${fmtUsdc(t.usageAll?.cleanRevenueUsdc ?? '0')} USDC`, note: `raw ${fmtUsdc(t.usageAll?.rawRevenueUsdc ?? '0')} USDC` },
      { label: 'PAID CALLS', value: compact(t.usageAll?.paidCalls ?? 0), note: 'charged on success only' },
      { label: 'BURNED', value: `${compact(1e9 - Number(m?.supply ?? 1e9))} ${t.symbol}`, note: 'by buyback' },
      { label: 'CLEAN PAYERS', value: String(t.usageAll?.cleanPayers ?? 0), note: 'distinct wallets, all time' },
    ],
    svcStatus: !svc ? 'No service' : health?.uptime7d == null ? 'Live' : health.uptime7d >= 0.95 ? 'Live' : 'Degraded',
    // Always the gateway link (VITE_API_BASE), never the creator's upstream URL.
    endpoint: svc ? agentLink(svc.slug) : 'No service registered yet',
    copyEndpoint: () => svc && navigator.clipboard?.writeText(agentLink(svc.slug)),
    svc: [
      { label: 'Price per call', value: priceUsdc ? `${priceUsdc} USDC` : '—' },
      { label: 'Success rate', value: health?.successRate == null ? '—' : `${(health.successRate * 100).toFixed(1)}%` },
      { label: 'Latency p50', value: health?.latencyP50Ms == null ? '—' : `${health.latencyP50Ms} ms` },
      { label: 'Latency p95', value: health?.latencyP95Ms == null ? '—' : health.latencyP95Ms >= 1000 ? `${(health.latencyP95Ms / 1000).toFixed(1)} s` : `${health.latencyP95Ms} ms` },
      { label: 'Uptime 7d', value: health?.uptime7d == null ? '—' : `${(health.uptime7d * 100).toFixed(1)}%` },
    ],
    // Example request (the creator's pasted link, as the gateway URL) and the response seen by the attach check.
    // Only when the service has a sample call (null for e.g. POST-only APIs without one; the agent link stays).
    exampleRequest: svc?.sample ? sampleRequestText(svc.slug, svc.sample) : null,
    copyExample: () => svc?.sample && navigator.clipboard?.writeText(sampleRequestText(svc.slug, svc.sample)),
    schema: (() => {
      const r = svc?.response;
      if (r?.kind === 'json' && r.sample) return r.sample;
      if (r?.kind === 'stream') return r.contentType?.startsWith('text/event-stream') ? 'Streams events (text/event-stream)' : `Streams text${r.contentType ? ` (${r.contentType.split(';')[0]})` : ''}`;
      if (r?.kind === 'file') return `Returns a file${r.contentType ? ` (${r.contentType.split(';')[0]})` : ''}`;
      return schemaShape(svc?.responseSchema ?? svc?.requestSchema ?? null);
    })(),
    tryLabel: svc ? `Try a sample call · ${priceLabel(svc.priceUsdc)} USDC` : '',
    tryShow: !!svc?.sample,
    payments: (payments.data?.payments ?? []).map((p) => {
      const [tag, color] = TAGS[p.class];
      const who = p.class === 'creator' ? 'creator' : p.payerServices > 0 ? `pays ${p.payerServices} service${p.payerServices === 1 ? '' : 's'}` : 'direct transfer';
      return { t: <TxLink h={p.txHash} label={fmtTime(p.timestamp)} />, who: <><AddrLink a={p.payer} /> · {who}</>, amt: `${fmtUsdc(p.amountUsdc)} USDC`, tag, color };
    }),
    paymentsState: payments.isLoading ? <Loading rows={2} height={32} />
      : payments.error ? <ErrorBox error={payments.error} retry={() => payments.refetch()} />
      : (payments.data?.payments.length ?? 0) === 0 ? <div style={{ padding: '14px 0', fontSize: '13px', color: MUTED }}>No payments yet.</div> : null,
    escrowLine: esc ? `${fmtUsdc(unlocked)} / ${fmtUsdc(esc.usdcAccrued)} ${esc.symbol}` : '—',
    escrowW: esc ? pct(unlocked, Number(esc.usdcAccrued)) : '0%',
    vestLine: vest ? `${((Number(vest.vested) / Number(vest.total || 1)) * 100).toFixed(1)}% of ${compact(vest.total, 0)}` : '—',
    vestW: vest ? pct(Number(vest.vested), Number(vest.total)) : '0%',
    escrowClaimed: esc ? `${fmtUsdc(esc.usdcClaimed)} ${esc.symbol}` : '—',
    escrowExpires: esc ? (esc.forfeited ? 'forfeited' : `in ${daysUntil(esc.forfeitAt)} days`) : '—',
    lastChange: t.serviceUpdatedAt ? `Updated · ${ago(t.serviceUpdatedAt)} ago` : '—',
    onTry: () => (wallet ? setTrying(true) : login?.()),
    tryDisabled: !svc?.sample || !cfg.data || (!wallet && !login),
    tryTitle: !PRIVY_ENABLED ? 'Set VITE_PRIVY_APP_ID to connect a wallet' : !wallet ? 'Connect a wallet to run a paid sample call' : `Runs ${svc?.sample ? `${svc.sample.method} ${svc.sample.path}` : ''} once, paid from your wallet`,
    modal: trying && svc?.sample && wallet && cfg.data ? (
      <SampleCall asset={t.asset as `0x${string}`} slug={svc.slug} sample={svc.sample} priceUsdc={svc.priceUsdc} wallet={wallet} config={cfg.data}
        onClose={() => setTrying(false)} onPaid={() => { void payments.refetch(); }} />
    ) : null,
  };
  return <TokenView v={v} />;
}

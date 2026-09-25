/**
 * /creator — docs/design/Creator.dc.html when the wallet has listed tokens, else CreatorEmpty.dc.html.
 * Wallet = connected wallet, or ?wallet=0x… for a read-only view. Claims and signed settings are Phase D.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CreatorView } from '../design/CreatorView.js';
import { CreatorEmptyView } from '../design/CreatorEmptyView.js';
import { api, type CreatorDash } from '../lib/api.js';
import { avatarFor, compact, fmtDate, fmtTime, fmtUsdc, shortAddr } from '../lib/format.js';
import { ErrorBox, Loading } from '../components/State.js';
import { useWalletAddress } from '../components/Site.js';
import { PageShell } from './Token.js';
import { AddrLink, TxLink } from '../components/Explorer.js';

const OK = '#34D399', BAD = '#F87171';
const NOTES: Record<string, string> = {
  upstream_error: 'Upstream error, not charged', verify_failed: 'Payment verification failed, not charged',
  settle_failed: 'Settlement failed, not charged',
};

export default function Creator() {
  const [params] = useSearchParams();
  const connected = useWalletAddress();
  const wallet = (params.get('wallet') ?? connected ?? '').toLowerCase();
  const valid = /^0x[0-9a-f]{40}$/.test(wallet);
  const [sel, setSel] = useState(0);
  const dash = useQuery({ queryKey: ['creator', wallet], queryFn: () => api.creator(wallet), enabled: valid });
  const list = useQuery({ queryKey: ['tokens', 30], queryFn: () => api.tokens(30), enabled: valid });
  const tok = dash.data?.tokens[Math.min(sel, (dash.data?.tokens.length ?? 1) - 1)];
  const detail = useQuery({ queryKey: ['token', tok?.asset], queryFn: () => api.token(tok!.asset), enabled: !!tok });

  if (!valid) return <CreatorEmptyView v={{}} />;
  if (dash.isLoading) return <PageShell><Loading rows={5} height={70} /></PageShell>;
  if (dash.error) return <PageShell><ErrorBox error={dash.error} retry={() => dash.refetch()} /></PageShell>;
  const d = dash.data as CreatorDash;
  if (d.tokens.length === 0 || !tok) return <CreatorEmptyView v={{}} />;

  const rev30 = (asset: string) => list.data?.tokens.find((x) => x.asset === asset)?.usage30d?.cleanRevenueUsdc ?? '0';
  const svc = d.services.find((s) => s.asset === tok.asset) ?? null;
  const health = detail.data?.serviceHealth;
  const esc = tok.escrow;
  const unlocked = esc ? Math.min(Number(esc.usdcAccrued), Number(esc.recordedRevenue) * 0.2) : 0;
  const vest = tok.vesting;
  const logs = d.recentRequests.filter((r) => !svc || r.service === svc.slug);

  const v = {
    wallet: <AddrLink a={wallet} label={`${wallet.slice(0, 10)}…${wallet.slice(-6)}`} />,
    tokens: d.tokens.map((t, i) => ({
      on: t.asset === tok.asset, pick: (e: React.MouseEvent) => { e.preventDefault(); setSel(i); }, href: `/token/${t.asset}`,
      initial: t.symbol.charAt(0), avatar: avatarFor(t.asset), sym: `$${t.symbol}`, sub: `${t.name} · ${fmtUsdc(rev30(t.asset))} USDC 30d`,
    })),
    claims: [
      { title: 'Trading fees', sub: '', big: tok.tradingFees ? `${compact(tok.tradingFees.numeraire)} ${tok.numeraireSymbol === 'MON' ? 'WMON' : 'USDC'}` : '—', color: '#ECEAF4',
        lines: [{ k: 'Also in tokens', v: tok.tradingFees ? `${compact(tok.tradingFees.asset)} ${tok.symbol}` : '—' }, { k: 'Basis', v: 'estimate' }],
        cta: 'Claim trading fees', border: '1px solid #25213A', bg: '#13111C', btnBg: '#8B5CF6', btnBorder: '0' },
      { title: 'Escrow', sub: '', big: esc?.claimable != null ? `${compact(esc.claimable)} ${esc.claimableSymbol}` : '—', color: '#34D399',
        lines: esc ? [
          { k: 'Collected from trading', v: `${fmtUsdc(esc.usdcAccrued)} USDC` }, { k: 'Unlocked by usage', v: `${fmtUsdc(unlocked)} USDC` },
          { k: 'Already claimed', v: `${fmtUsdc(esc.usdcClaimed)} USDC` }, { k: 'Unclaimed goes to buyback', v: esc.forfeited ? 'Forfeited' : fmtDate(esc.forfeitAt) },
        ] : [{ k: 'Escrow', v: 'unavailable' }],
        cta: esc?.claimable != null ? `Claim ${compact(esc.claimable)} ${esc.claimableSymbol}` : 'Claim', border: '1px solid #1F6B52', bg: '#0F221D', btnBg: '#10825F', btnBorder: '0' },
      { title: 'Allocation', sub: '15% of supply. 30-day cliff, linear to one year.', big: vest ? `${compact(vest.releasable)} ${tok.symbol}` : '—', color: '#C4B5FD',
        lines: vest ? [{ k: 'Total', v: compact(vest.total) }, { k: 'Claimed', v: compact(vest.released) }, { k: 'Locked', v: compact(vest.locked) }] : [{ k: 'Vesting', v: 'unavailable' }],
        cta: vest ? `Release ${compact(vest.releasable)} ${tok.symbol}` : 'Release', border: '1px solid #25213A', bg: '#13111C', btnBg: 'transparent', btnBorder: '1px solid #8B5CF6' },
    ],
    svcStatus: !svc ? 'No service registered' : !svc.active ? 'Paused'
      : health?.uptime7d != null ? `Live · ${(health.uptime7d * 100).toFixed(1)}% uptime, 7d` : 'Live',
    formKey: tok.asset, upstream: svc?.upstreamUrl ?? '', price: svc ? String(Number(svc.priceUsdc) / 1e6) : '', payout: shortAddr(wallet),
    logs: logs.map((r) => ({
      t: r.settleTxHash ? <TxLink h={r.settleTxHash} label={fmtTime(r.createdAt)} /> : fmtTime(r.createdAt), s: String(r.statusCode ?? '—'), color: r.charged ? OK : BAD,
      lat: r.latencyMs == null ? '—' : `${r.latencyMs.toLocaleString('en-US')} ms`,
      ch: r.charged ? `${fmtUsdc(r.amountUsdc)} USDC` : 'No',
      note: r.charged ? 'Settled by facilitator' : NOTES[r.errorCode ?? ''] ?? 'Not charged',
    })),
    logsState: logs.length === 0 ? <div style={{ padding: '14px 0', fontSize: '13px', color: '#8C87A3' }}>No calls yet.</div> : null,
  };
  return <CreatorView v={v} />;
}

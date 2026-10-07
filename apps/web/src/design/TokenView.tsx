// GENERATED from docs/design/Token.dc.html by apps/web/scripts/dc2tsx.py, then wired to real data.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Fragment } from 'react';
import { A, route } from '../components/A.js';
import { SiteHeader, SiteFooter } from '../components/Site.js';
import { CopyButton } from '../components/CopyButton.js';
import { ExampleResponse } from '../components/ExampleResponse.js';
import './TokenView.css';

export function TokenView({ v }: { v: any }) {
  return (
<div className="al-root" style={{ boxSizing: 'border-box', background: '#0B0A12', color: '#ECEAF4', fontFamily: 'Inter, system-ui, sans-serif', fontVariantNumeric: 'tabular-nums', display: 'flex', flexDirection: 'column' }}>
<SiteHeader active='' />
<main className="tv-main" style={{ padding: '28px var(--gutter) 40px', display: 'grid', gridTemplateColumns: '220px minmax(0,1fr)', gap: '28px', alignItems: 'start' }}>
<nav aria-label="Token sections" className="tv-side" style={{ position: 'sticky', top: '88px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
<div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '14px', border: '1px solid #25213A', borderRadius: '14px', background: '#13111C' }}>{v.avatarNode}<span><span style={{ display: 'block', fontWeight: '800' }}>{v.sym}</span><span style={{ display: 'block', fontSize: '12px', color: '#A7A2BD' }}>{v.name}</span></span></div>
<div className="tv-tabs" style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
<A href={v.infoHref} aria-current="page" style={{ height: '44px', boxSizing: 'border-box', padding: '0 12px', borderRadius: '10px', background: '#1B1530', border: '1px solid #8B5CF6', color: '#ECEAF4', display: 'flex', alignItems: 'center', gap: '10px', fontSize: '14px', fontWeight: '600', textDecoration: 'none' }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><rect x="3" y="3" width="7" height="9" rx="1.5"></rect><rect x="14" y="3" width="7" height="5" rx="1.5"></rect><rect x="14" y="12" width="7" height="9" rx="1.5"></rect><rect x="3" y="16" width="7" height="5" rx="1.5"></rect></svg>Info</A>
<A href={v.chartHref} style={{ height: '44px', boxSizing: 'border-box', padding: '0 12px', borderRadius: '10px', background: 'transparent', border: '1px solid transparent', color: '#A7A2BD', display: 'flex', alignItems: 'center', gap: '10px', fontSize: '14px', fontWeight: '600', textDecoration: 'none' }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M7 4v16M7 8h-2v6h2M17 3v18M17 7h2v8h-2M12 6v12M12 10h-2v4h2"></path></svg>{v.sym}</A>
</div>
<A href={route('Discover')} className="tv-back" style={{ fontSize: '13px', color: '#8C87A3', textDecoration: 'none', padding: '0 12px' }}>← All tokens</A>
</nav>
<div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>
<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '20px' }}>
<div>
<div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}><h1 className="tv-title">{v.title}</h1>{v.verified ? (<span style={{ fontSize: '12px', color: '#34D399', border: '1px solid rgba(52,211,153,0.45)', borderRadius: '999px', padding: '3px 10px' }}>Verified</span>) : null}</div>
<p className="tv-subtitle">{v.desc}</p>
</div>
</div>
<div className="tv-info-grid">
<section className="tv-card"><h2 className="tv-card-title">Project</h2>
<dl className="tv-rows">
<div className="tv-row"><dt>Creator</dt><dd><span className="tv-mono" title={v.creatorFull}>{v.creatorLabel}</span><CopyButton text={v.creatorFull} label="Copy creator address" variant="sm" /></dd></div>
<div className="tv-row"><dt>Token contract</dt><dd><span className="tv-mono" title={v.tokenFull}>{v.tokenShort}</span><CopyButton text={v.tokenFull} label="Copy token contract address" variant="sm" /></dd></div>
<div className="tv-row"><dt>X account</dt><dd>{v.xHandle ? <A href={v.xHref}>{v.xHandle}</A> : '—'}</dd></div>
<div className="tv-row"><dt>Website</dt><dd>{v.website ? <A href={v.website}>{v.websiteLabel}</A> : '—'}</dd></div>
<div className="tv-row"><dt>Launched</dt><dd>{v.launched}</dd></div>
</dl></section>
<section className="tv-card"><h2 className="tv-card-title">Market</h2>
<dl className="tv-rows">
<div className="tv-row"><dt>Price</dt><dd>{v.price}</dd></div>
<div className="tv-row"><dt>Market cap</dt><dd>{v.mcap}</dd></div>
<div className="tv-row"><dt>Volume 24h</dt><dd>{v.vol24}</dd></div>
<div className="tv-row"><dt>Holders</dt><dd>{v.holders}</dd></div>
<div className="tv-row"><dt>Pool</dt><dd>{v.poolLabel}</dd></div>
</dl></section>
</div>
<section aria-labelledby="ucr" className="tv-ucr" style={{ border: '1px solid #2A2640', borderRadius: '20px', padding: '28px', background: 'radial-gradient(700px 300px at 85% 90%, rgba(168,85,247,0.25), transparent 60%), #110F1A', display: 'flex', flexDirection: 'column', gap: '22px' }}>
<div className="tv-ucr-top" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '24px' }}>
<div><h2 id="ucr" style={{ margin: '0', fontFamily: 'Satoshi, Inter, system-ui, sans-serif', fontSize: '16px', fontWeight: '700', color: '#C4B5FD' }}>Usage coverage <span style={{ fontFamily: 'Inter, system-ui, sans-serif', fontSize: '13px', fontWeight: '500', color: '#8F8AA8' }}>· 30 days</span></h2><div style={{ marginTop: '8px', fontSize: '64px', lineHeight: '1', fontWeight: '800', letterSpacing: '-0.03em', background: 'linear-gradient(90deg,#6EE7B7,#34D399)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>{v.ucrBig}</div></div>
<p style={{ margin: '0', maxWidth: '380px', fontSize: '14px', lineHeight: '1.55', color: '#A7A2BD' }}>{v.ucrText}</p>
</div>
<div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
<div className="tv-bb-row" style={{ display: 'grid', gridTemplateColumns: '190px minmax(0,1fr) 90px', gap: '14px', alignItems: 'center' }}><span style={{ fontSize: '14px' }}>Buyback from usage</span><div style={{ height: '10px', borderRadius: '5px', background: '#221F33' }}><div style={{ height: '10px', width: v.bbUsageW, borderRadius: '5px', background: 'linear-gradient(90deg,#34D399,#6EE7B7)' }}></div></div><span style={{ textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontSize: '13px', color: '#34D399' }}>{v.bbUsage}</span></div>
<div className="tv-bb-row" style={{ display: 'grid', gridTemplateColumns: '190px minmax(0,1fr) 90px', gap: '14px', alignItems: 'center' }}><span style={{ fontSize: '14px' }}>Buyback from trading</span><div style={{ height: '10px', borderRadius: '5px', background: '#221F33' }}><div style={{ height: '10px', width: v.bbTradingW, borderRadius: '5px', background: 'linear-gradient(90deg,#8B5CF6,#C4B5FD)' }}></div></div><span style={{ textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontSize: '13px', color: '#C4B5FD' }}>{v.bbTrading}</span></div>
</div>
<dl className="tv-ucr-stats" style={{ margin: '0', display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', borderTop: '1px solid #25213A', paddingTop: '20px', gap: '16px' }}>
{(v.stats ?? []).map((s: any, sI: number) => (<Fragment key={sI}>
<div><dt style={{ fontSize: '13px', fontWeight: '500', color: '#8F8AA8' }}>{s.label}</dt><dd style={{ margin: '8px 0 0', fontSize: '22px', fontWeight: '700' }}>{s.value}</dd><dd style={{ margin: '4px 0 0', fontSize: '12px', color: '#8C87A3' }}>{s.note}</dd></div>
</Fragment>))}
</dl>
</section>
<section id="service" aria-labelledby="svc" className="tv-svc" style={{ border: '1px solid #25213A', borderRadius: '16px', background: '#13111C', padding: '22px 24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><h2 id="svc" style={{ margin: '0', fontSize: '18px', fontWeight: '700' }}>Service</h2><span style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#34D399' }}><span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#34D399' }}></span>{v.svcStatus}</span></div>
<div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
<div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}><span style={{ fontSize: '14px', fontWeight: '700' }}>Agent link</span><span style={{ fontSize: '12px', fontWeight: '600', padding: '3px 10px', borderRadius: '999px', background: '#2E2152', color: '#C4B5FD' }}>x402 · pay per call built in</span></div>
<div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 14px', borderRadius: '10px', background: '#0E0D16', border: '1px solid #25213A', fontFamily: "'JetBrains Mono', monospace", fontSize: '13px' }}><span style={{ flexGrow: '1', minWidth: '0', color: '#C9C5DA', overflowWrap: 'anywhere' }}>{v.endpoint}</span>{v.agentLinkText ? <CopyButton text={v.agentLinkText} label="Copy agent link" /> : null}</div>
</div>
<div className="tv-svc-tiles" style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0,1fr))', gap: '12px' }}>
{(v.svc ?? []).map((m: any, mI: number) => (<Fragment key={mI}>
<div style={{ padding: '14px', border: '1px solid #25213A', borderRadius: '12px', background: '#0E0D16' }}><div style={{ fontSize: '12px', color: '#8C87A3' }}>{m.label}</div><div title={m.muted ? m.value : undefined} style={m.muted ? { marginTop: '6px', height: '22px', lineHeight: '22px', fontSize: '13px', fontWeight: '500', color: '#8C87A3', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } : { marginTop: '6px', height: '22px', lineHeight: '22px', fontSize: '18px', fontWeight: '700' }}>{m.value}</div></div>
</Fragment>))}
</div>
<div className="tv-svc-split" style={{ display: 'grid', gridTemplateColumns: v.tryShow ? 'minmax(0,1fr) 300px' : 'minmax(0,1fr)', gap: '16px', alignItems: 'start' }}>
<div style={{ display: 'flex', flexDirection: 'column', gap: '8px', minWidth: '0' }}><span style={{ fontSize: '13px', fontWeight: '700' }}>Example response</span><ExampleResponse>{v.schema}</ExampleResponse></div>
{v.tryShow ? (<><div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}><span style={{ fontSize: '13px', fontWeight: '700' }}>Try it yourself</span><div style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '14px', borderRadius: '10px', background: '#0E0D16', border: '1px solid #25213A' }}><p style={{ margin: '0', fontSize: '13px', lineHeight: '1.55', color: '#C9C5DA' }}>Pay once from your wallet and see the real answer.</p><button type="button" onClick={v.onTry} disabled={v.tryDisabled} title={v.tryTitle} style={{ width: '100%', height: '44px', borderRadius: '999px', border: '0', background: '#8B5CF6', color: '#FFFFFF', fontFamily: 'inherit', fontSize: '14px', fontWeight: '700', cursor: 'pointer' }}>{v.tryLabel}</button></div></div></>) : null}
</div>
</section>
<section aria-labelledby="pay" className="tv-card">
<h2 id="pay" className="tv-card-title">Payments</h2>
<div className="tv-table">
<div className="tv-table-head"><span>Time</span><span>Payer</span><span className="tv-right tv-amt">Amount</span><span>Counted as</span></div>
{v.paymentsState}
{(v.payments ?? []).map((r: any, rI: number) => (<Fragment key={rI}>
<div className="tv-table-row"><span className="tv-dim">{r.t}</span><span className="tv-payer">{r.who}</span><span className="tv-right tv-num tv-amt">{r.amt}</span><span><span className="tv-tag" style={{ color: r.color, background: r.tagBg }}>{r.tag}</span></span></div>
</Fragment>))}
</div>
</section>
<section aria-labelledby="creator" className="tv-card">
<h2 id="creator" className="tv-card-title">Creator</h2>
<div className="tv-stack">
<div className="tv-meter"><div className="tv-row"><dt>Escrow unlocked by usage</dt><dd>{v.escrowLine}</dd></div><div className="tv-bar"><div style={{ width: v.escrowW, background: '#34D399' }}></div></div></div>
<div className="tv-meter"><div className="tv-row"><dt>Allocation vested</dt><dd>{v.vestLine}</dd></div><div className="tv-bar"><div style={{ width: v.vestW, background: '#C4B5FD' }}></div></div></div>
<dl className="tv-rows tv-rows--divided">
<div className="tv-row"><dt>Escrow claimed</dt><dd>{v.escrowClaimed}</dd></div>
<div className="tv-row"><dt>Escrow expires</dt><dd>{v.escrowExpires}</dd></div>
<div className="tv-row"><dt>Last service change</dt><dd>{v.lastChange}</dd></div>
</dl>
</div>
</section>
</div>
</main>
{v.modal}
<SiteFooter />
</div>
  );
}

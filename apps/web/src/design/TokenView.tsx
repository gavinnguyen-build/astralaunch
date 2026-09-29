// GENERATED from docs/design/Token.dc.html by apps/web/scripts/dc2tsx.py, then wired to real data.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Fragment } from 'react';
import { A, route } from '../components/A.js';
import { SiteHeader, SiteFooter } from '../components/Site.js';
import './TokenView.css';

export function TokenView({ v }: { v: any }) {
  return (
<div style={{ width: '1440px', minHeight: '1880px', boxSizing: 'border-box', background: '#0B0A12', color: '#ECEAF4', fontFamily: 'Inter, system-ui, sans-serif', fontVariantNumeric: 'tabular-nums', display: 'flex', flexDirection: 'column' }}>
<SiteHeader active='' />
<main style={{ padding: '28px 124px 40px', display: 'grid', gridTemplateColumns: '220px minmax(0,1fr)', gap: '28px', alignItems: 'start' }}>
<nav aria-label="Token sections" style={{ position: 'sticky', top: '24px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
<div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '14px', border: '1px solid #25213A', borderRadius: '14px', background: '#13111C' }}><span style={{ width: '42px', height: '42px', borderRadius: '11px', background: v.avatar, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px', fontWeight: '800', color: '#FFFFFF' }}>{v.initial}</span><span><span style={{ display: 'block', fontWeight: '800' }}>{v.sym}</span><span style={{ display: 'block', fontSize: '12px', color: '#A7A2BD' }}>{v.name}</span></span></div>
<div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
<A href={v.infoHref} aria-current="page" style={{ height: '44px', boxSizing: 'border-box', padding: '0 12px', borderRadius: '10px', background: '#1B1530', border: '1px solid #8B5CF6', color: '#ECEAF4', display: 'flex', alignItems: 'center', gap: '10px', fontSize: '14px', fontWeight: '600', textDecoration: 'none' }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><rect x="3" y="3" width="7" height="9" rx="1.5"></rect><rect x="14" y="3" width="7" height="5" rx="1.5"></rect><rect x="14" y="12" width="7" height="9" rx="1.5"></rect><rect x="3" y="16" width="7" height="5" rx="1.5"></rect></svg>Info</A>
<A href={v.chartHref} style={{ height: '44px', boxSizing: 'border-box', padding: '0 12px', borderRadius: '10px', background: 'transparent', border: '1px solid transparent', color: '#A7A2BD', display: 'flex', alignItems: 'center', gap: '10px', fontSize: '14px', fontWeight: '600', textDecoration: 'none' }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M7 4v16M7 8h-2v6h2M17 3v18M17 7h2v8h-2M12 6v12M12 10h-2v4h2"></path></svg>{v.sym}</A>
</div>
<A href={route('Discover')} style={{ fontSize: '13px', color: '#8C87A3', textDecoration: 'none', padding: '0 12px' }}>← All tokens</A>
</nav>
<div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>
<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '20px' }}>
<div>
<div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}><h1 style={{ margin: '0', fontSize: '34px', fontWeight: '800', letterSpacing: '-0.02em' }}>{v.title}</h1>{v.verified ? (<span style={{ fontSize: '12px', color: '#34D399', border: '1px solid rgba(52,211,153,0.45)', borderRadius: '999px', padding: '3px 10px' }}>Verified</span>) : null}</div>
<p style={{ margin: '8px 0 0', maxWidth: '640px', fontSize: '15px', lineHeight: '1.55', color: '#A7A2BD' }}>{v.desc}</p>
</div>
</div>
<div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: '16px' }}>
<section style={{ border: '1px solid #25213A', borderRadius: '16px', background: '#13111C', padding: '22px 24px', display: 'flex', flexDirection: 'column', gap: '16px' }}><h2 style={{ margin: '0', fontSize: '18px', fontWeight: '700' }}>Project</h2>
<dl style={{ margin: '0', display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '13px' }}>
<div style={{ display: 'flex', justifyContent: 'space-between' }}><dt style={{ color: '#8C87A3' }}>Creator</dt><dd style={{ margin: '0' }}>{v.creatorLabel}</dd></div>
<div style={{ display: 'flex', justifyContent: 'space-between' }}><dt style={{ color: '#8C87A3' }}>X account</dt><dd style={{ margin: '0' }}>{v.xHandle ? <A href={v.xHref}>{v.xHandle}</A> : '—'}</dd></div>
<div style={{ display: 'flex', justifyContent: 'space-between' }}><dt style={{ color: '#8C87A3' }}>Website</dt><dd style={{ margin: '0' }}>{v.website ? <A href={v.website}>{v.websiteLabel}</A> : '—'}</dd></div>
<div style={{ display: 'flex', justifyContent: 'space-between' }}><dt style={{ color: '#8C87A3' }}>Launched</dt><dd style={{ margin: '0' }}>{v.launched}</dd></div>
</dl></section>
<section style={{ border: '1px solid #25213A', borderRadius: '16px', background: '#13111C', padding: '22px 24px', display: 'flex', flexDirection: 'column', gap: '16px' }}><h2 style={{ margin: '0', fontSize: '18px', fontWeight: '700' }}>Contracts</h2>
<dl style={{ margin: '0', display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '13px' }}>
<div style={{ display: 'flex', justifyContent: 'space-between' }}><dt style={{ color: '#8C87A3' }}>Token</dt><dd style={{ margin: '0', fontFamily: "'JetBrains Mono', monospace" }}><span title={v.tokenFull}>{v.tokenShort}</span></dd></div>
<div style={{ display: 'flex', justifyContent: 'space-between' }}><dt style={{ color: '#8C87A3' }}>Revenue router</dt><dd style={{ margin: '0', fontFamily: "'JetBrains Mono', monospace" }}><span title={v.routerFull}>{v.routerShort}</span></dd></div>
<div style={{ display: 'flex', justifyContent: 'space-between' }}><dt style={{ color: '#8C87A3' }}>Pool</dt><dd style={{ margin: '0', fontFamily: "'JetBrains Mono', monospace" }}>{v.poolLabel}</dd></div>
<div style={{ display: 'flex', justifyContent: 'space-between' }}><dt style={{ color: '#8C87A3' }}>Fee recipient</dt><dd style={{ margin: '0', fontFamily: "'JetBrains Mono', monospace" }}>{v.feeRecipient}</dd></div>
</dl></section>
<section style={{ border: '1px solid #25213A', borderRadius: '16px', background: '#13111C', padding: '22px 24px', display: 'flex', flexDirection: 'column', gap: '16px' }}><h2 style={{ margin: '0', fontSize: '18px', fontWeight: '700' }}>Market</h2>
<dl style={{ margin: '0', display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '13px' }}>
<div style={{ display: 'flex', justifyContent: 'space-between' }}><dt style={{ color: '#8C87A3' }}>Price</dt><dd style={{ margin: '0', fontFamily: "'JetBrains Mono', monospace" }}>{v.price}</dd></div>
<div style={{ display: 'flex', justifyContent: 'space-between' }}><dt style={{ color: '#8C87A3' }}>Market cap</dt><dd style={{ margin: '0', fontFamily: "'JetBrains Mono', monospace" }}>{v.mcap}</dd></div>
<div style={{ display: 'flex', justifyContent: 'space-between' }}><dt style={{ color: '#8C87A3' }}>Volume 24h</dt><dd style={{ margin: '0', fontFamily: "'JetBrains Mono', monospace" }}>{v.vol24}</dd></div>
<div style={{ display: 'flex', justifyContent: 'space-between' }}><dt style={{ color: '#8C87A3' }}>Holders</dt><dd style={{ margin: '0', fontFamily: "'JetBrains Mono', monospace" }}>{v.holders}</dd></div>
</dl></section>
</div>
<section aria-labelledby="ucr" style={{ border: '1px solid #2A2640', borderRadius: '20px', padding: '28px', background: 'radial-gradient(700px 300px at 85% 90%, rgba(168,85,247,0.25), transparent 60%), #110F1A', display: 'flex', flexDirection: 'column', gap: '22px' }}>
<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '24px' }}>
<div><h2 id="ucr" style={{ margin: '0', fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', letterSpacing: '0.16em', fontWeight: '500', color: '#B9A8E8' }}>USAGE COVERAGE · 30 DAYS</h2><div style={{ marginTop: '8px', fontSize: '64px', lineHeight: '1', fontWeight: '800', letterSpacing: '-0.03em', background: 'linear-gradient(90deg,#6EE7B7,#34D399)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>{v.ucrBig}</div></div>
<p style={{ margin: '0', maxWidth: '380px', fontSize: '14px', lineHeight: '1.55', color: '#A7A2BD' }}>{v.ucrText}</p>
</div>
<div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
<div style={{ display: 'grid', gridTemplateColumns: '190px minmax(0,1fr) 90px', gap: '14px', alignItems: 'center' }}><span style={{ fontSize: '14px' }}>Buyback from usage</span><div style={{ height: '10px', borderRadius: '5px', background: '#221F33' }}><div style={{ height: '10px', width: v.bbUsageW, borderRadius: '5px', background: 'linear-gradient(90deg,#34D399,#6EE7B7)' }}></div></div><span style={{ textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontSize: '13px', color: '#34D399' }}>{v.bbUsage}</span></div>
<div style={{ display: 'grid', gridTemplateColumns: '190px minmax(0,1fr) 90px', gap: '14px', alignItems: 'center' }}><span style={{ fontSize: '14px' }}>Buyback from trading</span><div style={{ height: '10px', borderRadius: '5px', background: '#221F33' }}><div style={{ height: '10px', width: v.bbTradingW, borderRadius: '5px', background: 'linear-gradient(90deg,#8B5CF6,#C4B5FD)' }}></div></div><span style={{ textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontSize: '13px', color: '#C4B5FD' }}>{v.bbTrading}</span></div>
</div>
<dl style={{ margin: '0', display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', borderTop: '1px solid #25213A', paddingTop: '20px', gap: '16px' }}>
{(v.stats ?? []).map((s: any, sI: number) => (<Fragment key={sI}>
<div><dt style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '10px', letterSpacing: '0.14em', color: '#8C87A3' }}>{s.label}</dt><dd style={{ margin: '8px 0 0', fontSize: '22px', fontWeight: '700' }}>{s.value}</dd><dd style={{ margin: '4px 0 0', fontSize: '12px', color: '#8C87A3' }}>{s.note}</dd></div>
</Fragment>))}
</dl>
</section>
<section id="service" aria-labelledby="svc" style={{ border: '1px solid #25213A', borderRadius: '16px', background: '#13111C', padding: '22px 24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><h2 id="svc" style={{ margin: '0', fontSize: '18px', fontWeight: '700' }}>Service</h2><span style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#34D399' }}><span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#34D399' }}></span>{v.svcStatus}</span></div>
<div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
<div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}><span style={{ fontSize: '14px', fontWeight: '700' }}>Agent link</span><span style={{ fontSize: '12px', fontWeight: '600', padding: '3px 10px', borderRadius: '999px', background: '#2E2152', color: '#C4B5FD' }}>x402 · pay per call built in</span></div>
<div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 14px', borderRadius: '10px', background: '#0E0D16', border: '1px solid #25213A', fontFamily: "'JetBrains Mono', monospace", fontSize: '13px' }}><span style={{ color: '#A78BFA' }}>GET</span><span style={{ flexGrow: '1', color: '#C9C5DA' }}>{v.endpoint}</span><button type="button" onClick={v.copyEndpoint} aria-label="Copy agent link" title="Copy agent link" style={{ width: '36px', height: '36px', borderRadius: '8px', border: '1px solid #2A2640', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#C9C5DA" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a1 1 0 0 1 1-1h10"></path></svg></button></div>
{v.agentLine ? (<><p style={{ margin: '0', fontSize: '13px', color: '#A7A2BD' }}>{v.agentLine}</p></>) : null}
</div>
<div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0,1fr))', gap: '12px' }}>
{(v.svc ?? []).map((m: any, mI: number) => (<Fragment key={mI}>
<div style={{ padding: '14px', border: '1px solid #25213A', borderRadius: '12px', background: '#0E0D16' }}><div style={{ fontSize: '12px', color: '#8C87A3' }}>{m.label}</div><div style={{ marginTop: '6px', fontSize: '18px', fontWeight: '700' }}>{m.value}</div></div>
</Fragment>))}
</div>
<div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 300px', gap: '16px', alignItems: 'start' }}>
<pre style={{ margin: '0', padding: '14px', borderRadius: '10px', background: '#0E0D16', border: '1px solid #25213A', fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', lineHeight: '1.6', color: '#C9C5DA', overflowX: 'auto' }}>{v.schema}</pre>
<div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}><p style={{ margin: '0', fontSize: '13px', lineHeight: '1.55', color: '#A7A2BD' }}>{v.payNote}</p>{v.tryShow ? (<><button type="button" onClick={v.onTry} disabled={v.tryDisabled} title={v.tryTitle} style={{ height: '44px', borderRadius: '999px', border: '0', background: '#8B5CF6', color: '#FFFFFF', fontFamily: 'inherit', fontSize: '14px', fontWeight: '700', cursor: 'pointer' }}>{v.tryLabel}</button></>) : null}</div>
</div>
</section>
<section aria-labelledby="pay" style={{ border: '1px solid #25213A', borderRadius: '16px', background: '#13111C', padding: '22px 24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><h2 id="pay" style={{ margin: '0', fontSize: '18px', fontWeight: '700' }}>Payments</h2></div>
<div>
<div style={{ display: 'grid', gridTemplateColumns: '110px minmax(0,1fr) 110px 200px', gap: '12px', padding: '0 0 10px', fontFamily: "'JetBrains Mono', monospace", fontSize: '10px', letterSpacing: '0.12em', color: '#8C87A3' }}><span>TIME</span><span>PAYER</span><span style={{ textAlign: 'right' }}>AMOUNT</span><span>COUNTED AS</span></div>
{v.paymentsState}
{(v.payments ?? []).map((r: any, rI: number) => (<Fragment key={rI}>
<div style={{ display: 'grid', gridTemplateColumns: '110px minmax(0,1fr) 110px 200px', gap: '12px', padding: '11px 0', borderTop: '1px solid #1E1B2E', fontSize: '13px', alignItems: 'center' }}><span style={{ fontFamily: "'JetBrains Mono', monospace", color: '#8C87A3' }}>{r.t}</span><span>{r.who}</span><span style={{ textAlign: 'right', fontFamily: "'JetBrains Mono', monospace" }}>{r.amt}</span><span style={{ color: r.color }}>{r.tag}</span></div>
</Fragment>))}
</div>
</section>
<div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.2fr) minmax(0,1fr)', gap: '16px', alignItems: 'start' }}>
<section aria-labelledby="creator" style={{ border: '1px solid #25213A', borderRadius: '16px', background: '#13111C', padding: '22px 24px', display: 'flex', flexDirection: 'column', gap: '16px', width: '897px' }}>
<h2 id="creator" style={{ margin: '0', fontSize: '18px', fontWeight: '700' }}>Creator</h2>
<div><div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}><span style={{ color: '#8C87A3' }}>Escrow unlocked by usage</span><span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{v.escrowLine}</span></div><div style={{ marginTop: '8px', height: '8px', borderRadius: '4px', background: '#221F33' }}><div style={{ height: '8px', width: v.escrowW, borderRadius: '4px', background: '#34D399' }}></div></div></div>
<div><div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}><span style={{ color: '#8C87A3' }}>Allocation vested</span><span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{v.vestLine}</span></div><div style={{ marginTop: '8px', height: '8px', borderRadius: '4px', background: '#221F33' }}><div style={{ height: '8px', width: v.vestW, borderRadius: '4px', background: '#C4B5FD' }}></div></div></div>
<dl style={{ margin: '0', display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '13px' }}>
<div style={{ display: 'flex', justifyContent: 'space-between' }}><dt style={{ color: '#8C87A3' }}>Escrow claimed</dt><dd style={{ margin: '0', fontFamily: "'JetBrains Mono', monospace" }}>{v.escrowClaimed}</dd></div>
<div style={{ display: 'flex', justifyContent: 'space-between' }}><dt style={{ color: '#8C87A3' }}>Escrow expires</dt><dd style={{ margin: '0', fontFamily: "'JetBrains Mono', monospace" }}>{v.escrowExpires}</dd></div>
<div style={{ display: 'flex', justifyContent: 'space-between' }}><dt style={{ color: '#8C87A3' }}>Last service change</dt><dd style={{ margin: '0' }}>{v.lastChange}</dd></div>
</dl>
</section>
</div>
</div>
</main>
{v.modal}
<SiteFooter />
</div>
  );
}

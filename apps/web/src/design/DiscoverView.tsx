// GENERATED from docs/design/Discover.dc.html by apps/web/scripts/dc2tsx.py, then wired to real data.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Fragment } from 'react';
import { A } from '../components/A.js';
import { SiteHeader, SiteFooter } from '../components/Site.js';
import './DiscoverView.css';

export function DiscoverView({ v }: { v: any }) {
  return (
<div style={{ width: '1440px', minHeight: '960px', boxSizing: 'border-box', background: '#0B0A12', color: '#ECEAF4', fontFamily: 'Inter, system-ui, sans-serif', fontVariantNumeric: 'tabular-nums', display: 'flex', flexDirection: 'column' }}>
<SiteHeader active='discover' />
<main style={{ padding: '28px 124px 44px', display: 'flex', flexDirection: 'column' }}>
<section aria-labelledby="dash" style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
<div><h2 id="dash" style={{ margin: '0', fontSize: '22px', fontWeight: '800' }}>Astralaunch overview</h2><p style={{ margin: '6px 0 0', fontSize: '13px', color: '#8C87A3' }}>Every token on the platform, combined.</p></div>
<div role="group" aria-label="Range" style={{ display: 'flex', gap: '4px', padding: '4px', borderRadius: '999px', background: '#13111C', border: '1px solid #25213A' }}>
{(v.ranges ?? []).map((r: any, rI: number) => (<Fragment key={rI}><button type="button" aria-pressed={r.on} onClick={r.pick} style={{ height: '32px', padding: '0 14px', borderRadius: '999px', border: '0', background: r.bg, color: r.fg, fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', fontWeight: '600', cursor: 'pointer' }}>{r.label}</button></Fragment>))}
</div>
</div>
<section aria-labelledby="alltok" style={{ border: '1px solid #25213A', borderRadius: '16px', background: '#13111C', padding: '18px 20px 8px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px' }}>
<div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}><h2 id="alltok" style={{ margin: '0', fontSize: '18px', fontWeight: '700' }}>All tokens</h2>
<div style={{ display: 'flex', gap: '6px' }}>{(v.filters ?? []).map((f: any, fI: number) => (<Fragment key={fI}><button type="button" aria-pressed={f.pressed} onClick={f.pick} style={{ height: '32px', padding: '0 12px', borderRadius: '999px', border: f.border, background: f.bg, color: f.fg, fontFamily: 'inherit', fontSize: '12px', cursor: 'pointer' }}>{f.label}</button></Fragment>))}</div></div>
<label style={{ display: 'flex', alignItems: 'center', gap: '10px', width: '260px', height: '38px', boxSizing: 'border-box', padding: '0 14px', border: '1px solid #2A2640', borderRadius: '999px' }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8C87A3" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg><input type="search" value={v.query} onChange={v.onQuery} placeholder="Ticker, service or creator" aria-label="Search tokens" style={{ border: '0', outline: 'none', background: 'transparent', color: '#ECEAF4', fontFamily: 'inherit', fontSize: '13px', width: '100%' }} /></label>
</div>
<div style={{ display: 'grid', gridTemplateColumns: '40px minmax(0,1.6fr) 110px 80px 90px 120px 70px 90px 110px', gap: '10px', padding: '0 8px 8px', borderBottom: '1px solid #25213A', fontFamily: "'JetBrains Mono', monospace", fontSize: '10px', letterSpacing: '0.12em', color: '#8C87A3' }}><span>#</span><span>TOKEN</span><span style={{ textAlign: 'right' }}>PRICE</span><span style={{ textAlign: 'right' }}>24H</span><span style={{ textAlign: 'right' }}>MCAP</span><span style={{ textAlign: 'right' }}>REVENUE {v.range}</span><span style={{ textAlign: 'right' }}>UCR</span><span style={{ textAlign: 'right' }}>CALLS</span><span style={{ textAlign: 'right' }}>7D</span></div>
<div style={{ display: 'flex', flexDirection: 'column' }}>
{v.rowsState}
{(v.rows ?? []).map((t: any, tI: number) => (<Fragment key={tI}>
<A href={t.href} style={{ display: 'grid', gridTemplateColumns: '40px minmax(0,1.6fr) 110px 80px 90px 120px 70px 90px 110px', gap: '10px', alignItems: 'center', padding: '10px 8px', borderBottom: '1px solid #1E1B2E', borderRadius: '8px', color: '#ECEAF4', textDecoration: 'none', fontSize: '13px' }}>
<span style={{ fontFamily: "'JetBrains Mono', monospace", color: '#8C87A3' }}>{t.rank}</span>
<span style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: '0' }}><span style={{ width: '32px', height: '32px', flexShrink: '0', borderRadius: '9px', background: t.avatar, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: '800', color: '#FFFFFF' }}>{t.initial}</span><span style={{ minWidth: '0' }}><span style={{ display: 'block', fontWeight: '700' }}>{t.sym}</span><span style={{ display: 'block', fontSize: '12px', color: '#8C87A3', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</span></span></span>
<span style={{ textAlign: 'right', fontFamily: "'JetBrains Mono', monospace" }}>{t.price}</span>
<span style={{ textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color: t.chgColor }}>{t.chg}</span>
<span style={{ textAlign: 'right', fontFamily: "'JetBrains Mono', monospace" }}>{t.mcap}</span>
<span style={{ textAlign: 'right', fontFamily: "'JetBrains Mono', monospace" }}>{t.rev} <span style={{ color: '#A78BFA' }}>USDC</span></span>
<span style={{ textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color: t.ucrColor }}>{t.ucr}</span>
<span style={{ textAlign: 'right', fontFamily: "'JetBrains Mono', monospace" }}>{t.calls}</span>
<svg viewBox="0 0 100 30" preserveAspectRatio="none" style={{ width: '100%', height: '28px', display: 'block' }} aria-hidden="true"><polyline points={t.spark} fill="none" stroke={t.chgColor} strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round"></polyline></svg>
</A>
</Fragment>))}
</div>
<div style={{ padding: '8px 8px 10px', fontSize: '12px', color: '#8C87A3' }}>Showing {v.shown} of {v.total} tokens</div>
</section>
</section>
</main>
<SiteFooter />
</div>
  );
}

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
<div><h2 id="dash" style={{ margin: '0', fontFamily: 'Satoshi, Inter, system-ui, sans-serif', fontSize: '22px', fontWeight: '700' }}>Discover</h2></div>
<div role="group" aria-label="Range" style={{ display: 'flex', gap: '4px', padding: '4px', borderRadius: '999px', background: '#13111C', border: '1px solid #25213A' }}>
{(v.ranges ?? []).map((r: any, rI: number) => (<Fragment key={rI}><button type="button" aria-pressed={r.on} onClick={r.pick} style={{ height: '32px', padding: '0 14px', borderRadius: '999px', border: '0', background: r.bg, color: r.fg, fontFamily: 'Inter, system-ui, sans-serif', fontSize: '12px', fontWeight: '600', cursor: 'pointer' }}>{r.label}</button></Fragment>))}
</div>
</div>
<section aria-labelledby="alltok" style={{ border: '1px solid #25213A', borderRadius: '16px', background: '#13111C', padding: '18px 20px 8px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px' }}>
<div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}><h2 id="alltok" style={{ margin: '0', fontFamily: 'Satoshi, Inter, system-ui, sans-serif', fontSize: '18px', fontWeight: '700' }}>All tokens</h2>
<div style={{ display: 'flex', gap: '6px' }}>{(v.filters ?? []).map((f: any, fI: number) => (<Fragment key={fI}><button type="button" aria-pressed={f.pressed} onClick={f.pick} style={{ height: '32px', padding: '0 12px', borderRadius: '999px', border: f.border, background: f.bg, color: f.fg, fontFamily: 'inherit', fontSize: '12px', cursor: 'pointer' }}>{f.label}</button></Fragment>))}</div></div>
<label style={{ display: 'flex', alignItems: 'center', gap: '10px', width: '260px', height: '38px', boxSizing: 'border-box', padding: '0 14px', border: '1px solid #2A2640', borderRadius: '999px' }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8C87A3" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg><input type="search" value={v.query} onChange={v.onQuery} placeholder="Ticker, service or creator" aria-label="Search tokens" style={{ border: '0', outline: 'none', background: 'transparent', color: '#ECEAF4', fontFamily: 'inherit', fontSize: '13px', width: '100%' }} /></label>
</div>
<div style={{ display: 'grid', gridTemplateColumns: '40px 220px repeat(6, minmax(0,1fr)) 120px', gap: '16px', padding: '0 8px 8px', borderBottom: '1px solid #25213A', fontFamily: 'Inter, system-ui, sans-serif', fontSize: '12px', fontWeight: '500', color: '#8F8AA8' }}><span>#</span><span>Token</span><span role="columnheader" aria-sort={v.cols.price.ariaSort} style={{ textAlign: 'right' }}><button type="button" onClick={v.cols.price.pick} style={{ border: '0', background: 'transparent', padding: '0', color: v.cols.price.color, font: 'inherit', letterSpacing: 'inherit', cursor: 'pointer' }}>{v.cols.price.arrow ? <span aria-hidden="true" style={{ marginRight: '4px', color: '#A78BFA' }}>{v.cols.price.arrow}</span> : null}{v.cols.price.label}</button></span><span role="columnheader" aria-sort={v.cols.change24h.ariaSort} style={{ textAlign: 'right' }}><button type="button" onClick={v.cols.change24h.pick} style={{ border: '0', background: 'transparent', padding: '0', color: v.cols.change24h.color, font: 'inherit', letterSpacing: 'inherit', cursor: 'pointer' }}>{v.cols.change24h.arrow ? <span aria-hidden="true" style={{ marginRight: '4px', color: '#A78BFA' }}>{v.cols.change24h.arrow}</span> : null}{v.cols.change24h.label}</button></span><span role="columnheader" aria-sort={v.cols.mcap.ariaSort} style={{ textAlign: 'right' }}><button type="button" onClick={v.cols.mcap.pick} style={{ border: '0', background: 'transparent', padding: '0', color: v.cols.mcap.color, font: 'inherit', letterSpacing: 'inherit', cursor: 'pointer' }}>{v.cols.mcap.arrow ? <span aria-hidden="true" style={{ marginRight: '4px', color: '#A78BFA' }}>{v.cols.mcap.arrow}</span> : null}{v.cols.mcap.label}</button></span><span role="columnheader" aria-sort={v.cols.revenue.ariaSort} style={{ textAlign: 'right' }}><button type="button" onClick={v.cols.revenue.pick} style={{ border: '0', background: 'transparent', padding: '0', color: v.cols.revenue.color, font: 'inherit', letterSpacing: 'inherit', cursor: 'pointer' }}>{v.cols.revenue.arrow ? <span aria-hidden="true" style={{ marginRight: '4px', color: '#A78BFA' }}>{v.cols.revenue.arrow}</span> : null}{v.cols.revenue.label}</button></span><span role="columnheader" aria-sort={v.cols.ucr.ariaSort} style={{ textAlign: 'right' }}><button type="button" onClick={v.cols.ucr.pick} style={{ border: '0', background: 'transparent', padding: '0', color: v.cols.ucr.color, font: 'inherit', letterSpacing: 'inherit', cursor: 'pointer' }}>{v.cols.ucr.arrow ? <span aria-hidden="true" style={{ marginRight: '4px', color: '#A78BFA' }}>{v.cols.ucr.arrow}</span> : null}{v.cols.ucr.label}</button></span><span role="columnheader" aria-sort={v.cols.calls.ariaSort} style={{ textAlign: 'right' }}><button type="button" onClick={v.cols.calls.pick} style={{ border: '0', background: 'transparent', padding: '0', color: v.cols.calls.color, font: 'inherit', letterSpacing: 'inherit', cursor: 'pointer' }}>{v.cols.calls.arrow ? <span aria-hidden="true" style={{ marginRight: '4px', color: '#A78BFA' }}>{v.cols.calls.arrow}</span> : null}{v.cols.calls.label}</button></span><span aria-hidden="true"></span></div>
<div style={{ display: 'flex', flexDirection: 'column' }}>
{v.rowsState}
{(v.rows ?? []).map((t: any, tI: number) => (<Fragment key={tI}>
<A href={t.href} style={{ display: 'grid', gridTemplateColumns: '40px 220px repeat(6, minmax(0,1fr)) 120px', gap: '16px', alignItems: 'center', padding: '10px 8px', borderBottom: '1px solid #1E1B2E', borderRadius: '8px', color: '#ECEAF4', textDecoration: 'none', fontSize: '13px', fontFamily: 'Inter, system-ui, sans-serif', fontVariantNumeric: 'tabular-nums' }}>
<span style={{ fontWeight: '500', color: '#8F8AA8' }}>{t.rank}</span>
<span style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: '0' }}>{t.avatarNode}<span style={{ minWidth: '0' }}><span style={{ display: 'block', fontWeight: '600', fontSize: '14px' }}>{t.sym}</span><span style={{ display: 'block', fontSize: '12px', fontWeight: '500', color: '#8F8AA8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</span></span></span>
<span style={{ textAlign: 'right', fontWeight: '600' }}>{t.price}</span>
<span style={{ textAlign: 'right', fontWeight: '600', color: t.chgColor }}>{t.chg}</span>
<span style={{ textAlign: 'right', fontWeight: '600' }}>{t.mcap}</span>
<span style={{ textAlign: 'right', fontWeight: '600' }}>{t.rev} <span style={{ color: '#8F8AA8', fontWeight: '500' }}>USDC</span></span>
<span style={{ textAlign: 'right', fontWeight: '600', color: t.ucrColor }}>{t.ucr}</span>
<span style={{ textAlign: 'right', fontWeight: '600' }}>{t.calls}</span>
<svg viewBox="0 0 100 30" preserveAspectRatio="none" style={{ width: '100%', height: '28px', display: 'block' }} aria-hidden="true"><polyline points={t.spark} fill="none" stroke={t.chgColor} strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round"></polyline></svg>
</A>
</Fragment>))}
</div>
<nav aria-label="Pagination" style={{ padding: '8px 8px 10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px' }}>
<span style={{ fontSize: '12px', color: '#8C87A3' }}>{v.showing}</span>
<div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
<button type="button" onClick={v.prev} disabled={v.prevDisabled} aria-label="Previous page" style={{ width: '32px', height: '32px', borderRadius: '999px', border: '1px solid #2A2640', background: 'transparent', color: v.prevDisabled ? '#4A4560' : '#ECEAF4', cursor: v.prevDisabled ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"></path></svg></button>
{(v.pages ?? []).map((p: any) => (<Fragment key={p.key}>{p.gap
? <span aria-hidden="true" style={{ minWidth: '20px', textAlign: 'center', fontSize: '12px', color: '#8C87A3' }}>…</span>
: <button type="button" onClick={p.pick} aria-current={p.current} aria-label={`Page ${p.label}`} style={{ minWidth: '32px', height: '32px', padding: '0 8px', boxSizing: 'border-box', borderRadius: '999px', border: p.border, background: p.bg, color: p.fg, fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', cursor: 'pointer' }}>{p.label}</button>}</Fragment>))}
<button type="button" onClick={v.next} disabled={v.nextDisabled} aria-label="Next page" style={{ width: '32px', height: '32px', borderRadius: '999px', border: '1px solid #2A2640', background: 'transparent', color: v.nextDisabled ? '#4A4560' : '#ECEAF4', cursor: v.nextDisabled ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg></button>
</div>
</nav>
</section>
</section>
</main>
<SiteFooter />
</div>
  );
}

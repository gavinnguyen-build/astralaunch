// GENERATED from docs/design/TokenChart.dc.html by apps/web/scripts/dc2tsx.py, then wired to real data.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Fragment } from 'react';
import { A, route } from '../components/A.js';
import { SiteHeader, SiteFooter } from '../components/Site.js';
import './TokenChartView.css';

export function TokenChartView({ v }: { v: any }) {
  return (
<div className="al-root" style={{ boxSizing: 'border-box', background: '#0B0A12', color: '#ECEAF4', fontFamily: 'Inter, system-ui, sans-serif', fontVariantNumeric: 'tabular-nums', display: 'flex', flexDirection: 'column' }}>
<SiteHeader active='' />
<div style={{ padding: '16px 13px 0', display: 'flex', alignItems: 'center', gap: '16px' }}>
<A href={route('Discover')} style={{ fontSize: '13px', color: '#8C87A3', textDecoration: 'none' }}>← All tokens</A>
<nav aria-label="Token sections" style={{ display: 'flex', gap: '4px', padding: '4px', borderRadius: '999px', background: '#1C1A29' }}>
<A href={v.infoHref} style={{ height: '32px', boxSizing: 'border-box', padding: '0 16px', borderRadius: '999px', color: '#8C87A3', fontSize: '13px', fontWeight: '600', display: 'flex', alignItems: 'center', textDecoration: 'none' }}>Info</A>
<A href={v.chartHref} aria-current="page" style={{ height: '32px', boxSizing: 'border-box', padding: '0 16px', borderRadius: '999px', background: '#2A2640', color: '#ECEAF4', fontSize: '13px', fontWeight: '600', display: 'flex', alignItems: 'center', textDecoration: 'none' }}>{v.sym}</A>
</nav>
</div>
<div style={{ background: '#0B0A12', color: '#ECEAF4', fontFamily: 'Inter,system-ui,sans-serif', padding: '13px', boxSizing: 'border-box', display: 'flex', flexWrap: 'wrap', gap: '13px', alignItems: 'flex-start' }}>
<main style={{ flex: '999 1 520px', minWidth: '0', display: 'flex', flexDirection: 'column', gap: '13px' }}>
<section style={{ background: '#14121E', border: '1px solid #2E2A45', borderRadius: '32px', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
<div style={{ display: 'flex', alignItems: 'center', gap: '13px', padding: '13px 18px', flexWrap: 'wrap' }}>
<div style={{ display: 'flex', gap: '2px', background: '#1C1A29', borderRadius: '999px', padding: '4px' }}>
{(v.timeframes ?? []).map((tf: any, tfI: number) => (<Fragment key={tfI}>
<button onClick={tf.select} disabled={tf.disabled} title={tf.title} style={{ border: '0', cursor: 'pointer', height: '30px', minWidth: '38px', padding: '0 10px', borderRadius: '999px', fontFamily: 'Inter,system-ui,sans-serif', fontWeight: '600', fontSize: '13px', whiteSpace: 'nowrap', background: tf.bg, color: tf.fg }}>{tf.label}</button>
</Fragment>))}
</div>
<div style={{ display: 'flex', gap: '2px', background: '#1C1A29', borderRadius: '999px', padding: '4px' }}>
{(v.styles ?? []).map((st: any, stI: number) => (<Fragment key={stI}>
<button onClick={st.select} title={st.label} style={{ border: '0', cursor: 'pointer', height: '30px', padding: '0 12px', borderRadius: '999px', fontFamily: 'Inter,system-ui,sans-serif', fontWeight: '600', fontSize: '13px', whiteSpace: 'nowrap', background: st.bg, color: st.fg }}>{st.label}</button>
</Fragment>))}
</div>
<div style={{ display: 'flex', gap: '2px', background: '#1C1A29', borderRadius: '999px', padding: '4px' }}>
{(v.units ?? []).map((u: any, uI: number) => (<Fragment key={uI}>
<button onClick={u.select} style={{ border: '0', cursor: 'pointer', height: '30px', padding: '0 12px', borderRadius: '999px', fontFamily: 'Inter,system-ui,sans-serif', fontWeight: '600', fontSize: '13px', whiteSpace: 'nowrap', background: u.bg, color: u.fg }}>{u.label}</button>
</Fragment>))}
</div>
<div style={{ marginLeft: 'auto', display: 'flex', gap: '4px' }}>
<button title="Undo (drawing tools are not available yet)" disabled style={{ width: '36px', height: '36px', borderRadius: '50%', border: '0', background: 'transparent', color: '#C9C5DA', cursor: 'pointer', display: 'grid', placeItems: 'center' }} className="dc-tokenchart-hover-1"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round"><path d="M9 14 4 9l5-5"></path><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"></path></svg></button>
<button title="Settings (not available yet)" disabled style={{ width: '36px', height: '36px', borderRadius: '50%', border: '0', background: 'transparent', color: '#C9C5DA', cursor: 'pointer', display: 'grid', placeItems: 'center' }} className="dc-tokenchart-hover-2"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"></path></svg></button>
<button title="Fullscreen" onClick={v.fullscreen} style={{ width: '36px', height: '36px', borderRadius: '50%', border: '0', background: 'transparent', color: '#C9C5DA', cursor: 'pointer', display: 'grid', placeItems: 'center' }} className="dc-tokenchart-hover-3"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"></path></svg></button>
</div>
</div>
<div style={{ display: 'flex', minWidth: '0' }}>
<div style={{ flex: 'none', display: 'flex', flexDirection: 'column', gap: '6px', padding: '9px 9px 13px 13px' }}>
{(v.tools ?? []).map((t: any, tI: number) => (<Fragment key={tI}>
<button onClick={t.select} disabled={t.disabled} title={t.title} style={{ width: '40px', height: '40px', borderRadius: '50%', border: '0', cursor: 'pointer', display: 'grid', placeItems: 'center', background: t.bg, color: t.fg }} className="dc-tokenchart-hover-4">
<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round"><path d={t.d}></path></svg>
</button>
</Fragment>))}
</div>
<div style={{ flex: '1', minWidth: '0', padding: '0 18px 0 9px', display: 'flex', flexDirection: 'column', gap: '9px' }}>
<div style={{ display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '13px', fontFamily: "'JetBrains Mono',monospace", fontVariantNumeric: 'tabular-nums' }}>
<div style={{ display: 'flex', alignItems: 'center', gap: '9px', flexWrap: 'wrap' }}>
<span style={{ fontFamily: 'Inter,system-ui,sans-serif', fontWeight: '700', letterSpacing: '-0.01em', fontSize: '17px' }}>{v.pairLabel} ({v.unitName}) on Uniswap v4 · {v.tfLabel}</span>
<span style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#34D399' }}></span>
</div>
<div style={{ display: 'flex', gap: '13px', flexWrap: 'wrap', color: '#8C87A3' }}>
<span>O <b style={{ color: '#6EE7B7' }}>{v.ohlc.o}</b></span>
<span>H <b style={{ color: '#6EE7B7' }}>{v.ohlc.h}</b></span>
<span>L <b style={{ color: '#6EE7B7' }}>{v.ohlc.l}</b></span>
<span>C <b style={{ color: '#6EE7B7' }}>{v.ohlc.c}</b></span>
<span style={{ color: v.chgColor, fontWeight: '700' }}>{v.chgLabel}</span>
<span>Volume <b style={{ color: '#6EE7B7' }}>{v.volLabel}</b></span>{v.usdHint}
</div>
</div>
<div style={{ position: 'relative', height: '470px', borderTop: '1px solid #25213A' }}>
<div ref={v.chartRef} style={{ position: 'absolute', inset: '0' }}></div>
{v.chartState}
</div>
<div style={{ display: 'flex', alignItems: 'center', gap: '13px', padding: '9px 0 18px', flexWrap: 'wrap' }}>
<div style={{ display: 'flex', gap: '2px' }}>
{(v.ranges ?? []).map((_r: any, rI: number) => (<Fragment key={rI}>
</Fragment>))}
</div>
<span style={{ marginLeft: 'auto', fontSize: '13px', color: '#8C87A3', fontFamily: "'JetBrains Mono',monospace", fontVariantNumeric: 'tabular-nums' }}>{v.clock}</span>
<div style={{ display: 'flex', gap: '2px', fontSize: '13px', fontWeight: '600' }}>
<button type="button" onClick={v.scale.pct.pick} style={{ padding: '4px 10px', borderRadius: '999px', border: '0', fontFamily: 'inherit', fontSize: '13px', fontWeight: 600, cursor: 'pointer', color: v.scale.pct.fg, background: v.scale.pct.bg }}>%</button>
<button type="button" onClick={v.scale.log.pick} style={{ padding: '4px 10px', borderRadius: '999px', border: '0', fontFamily: 'inherit', fontSize: '13px', fontWeight: 600, cursor: 'pointer', color: v.scale.log.fg, background: v.scale.log.bg }}>log</button>
<button type="button" onClick={v.scale.auto.pick} style={{ padding: '4px 10px', borderRadius: '999px', border: '0', fontFamily: 'inherit', fontSize: '13px', fontWeight: 600, cursor: 'pointer', color: v.scale.auto.fg, background: v.scale.auto.bg }}>auto</button>
</div>
</div>
</div>
</div>
</section>
<section style={{ background: '#14121E', border: '1px solid #2E2A45', borderRadius: '32px', padding: '13px 18px 18px', display: 'flex', flexDirection: 'column', gap: '13px', minWidth: '0' }}>
<div style={{ display: 'flex', alignItems: 'center', gap: '13px', flexWrap: 'wrap' }}>
<div style={{ display: 'flex', gap: '2px', background: '#1C1A29', borderRadius: '999px', padding: '4px', flexWrap: 'wrap' }}>
{(v.tabs ?? []).map((t: any, tI: number) => (<Fragment key={tI}>
<button onClick={t.select} style={{ border: '0', cursor: 'pointer', height: '34px', padding: '0 16px', borderRadius: '999px', fontFamily: 'Inter,system-ui,sans-serif', fontWeight: '600', fontSize: '14px', whiteSpace: 'nowrap', background: t.bg, color: t.fg }}>{t.label}</button>
</Fragment>))}
</div>
<span style={{ marginLeft: 'auto', fontSize: '13px', color: '#8C87A3' }}>Live</span>
</div>
<div style={{ overflowX: 'auto' }}>
<table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', fontFamily: "'JetBrains Mono',monospace", fontVariantNumeric: 'tabular-nums', minWidth: '720px' }}>
<thead>
<tr>
{(v.cols ?? []).map((h: any, hI: number) => (<Fragment key={hI}>
<th style={{ textAlign: h.align, fontSize: '11px', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: "'JetBrains Mono',monospace", color: '#8C87A3', fontWeight: '600', padding: '10px 12px', borderBottom: '1px solid #2A2640', whiteSpace: 'nowrap' }}>{h.label}</th>
</Fragment>))}
</tr>
</thead>
<tbody>
{(v.rows ?? []).map((r: any, rI: number) => (<Fragment key={rI}>
<tr className="dc-tokenchart-hover-5">
{(r.cells ?? []).map((cell: any, cellI: number) => (<Fragment key={cellI}>
<td style={{ padding: '12px', textAlign: cell.align, color: cell.fg, fontWeight: cell.weight, borderBottom: '1px solid #25213A', whiteSpace: 'nowrap' }}>
{cell.pill ? (<>
<span style={{ display: 'inline-flex', fontSize: '12px', fontWeight: '700', padding: '3px 12px', borderRadius: '999px', background: cell.pillBg, color: cell.pillFg }}>{cell.text}</span>
</>) : null}
{cell.plain ? (<>{cell.text}</>) : null}
</td>
</Fragment>))}
</tr>
</Fragment>))}
</tbody>
</table>
{v.tableState}
</div>
</section>
</main>
<aside style={{ flex: '1 1 320px', maxWidth: '100%', display: 'flex', flexDirection: 'column', gap: '9px' }}>
<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', padding: '9px 0' }}>
<div style={{ display: 'flex', alignItems: 'baseline', gap: '9px' }}>
{v.avatarNode}<span style={{ fontFamily: 'Inter,system-ui,sans-serif', fontWeight: '700', letterSpacing: '-0.01em', fontSize: '26px', color: '#A78BFA' }}>{v.symPlain}</span>
<span style={{ fontFamily: 'Inter,system-ui,sans-serif', fontWeight: '700', letterSpacing: '-0.01em', fontSize: '26px' }}>/ {v.numSym}</span>
<span style={{ background: '#2E2152', color: '#C4B5FD', fontSize: '11px', fontWeight: '700', padding: '3px 10px', borderRadius: '999px' }}>#{v.rank}</span>
</div>
<div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: '#8C87A3' }}>
<span>Monad</span><span>›</span><span>Uniswap v4</span>
<span style={{ background: '#1C1A29', fontSize: '11px', padding: '2px 8px', borderRadius: '999px' }}>2% fee</span>
</div>
</div>
{v.heroSrc ? (<><div style={{ position: 'relative', height: '150px', borderRadius: '28px', overflow: 'hidden', border: '1px solid #2A2640', background: '#0B0A12' }}><img src={v.heroSrc} alt="" aria-hidden="true" style={{ position: 'absolute', inset: '-24px', width: 'calc(100% + 48px)', height: 'calc(100% + 48px)', objectFit: 'cover', filter: 'blur(22px) brightness(0.45)', transform: 'scale(1.05)' }} /><img src={v.heroSrc} alt={v.heroAlt} onError={v.onHeroError} style={{ position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: 'contain' }} /><span style={{ position: 'absolute', left: '50%', bottom: '10px', transform: 'translateX(-50%)', maxWidth: 'calc(100% - 24px)', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: 'Inter,system-ui,sans-serif', fontSize: '12px', fontWeight: '500', color: '#C9C5DA', background: 'rgba(11,10,18,0.72)', padding: '4px 12px', borderRadius: '999px', whiteSpace: 'nowrap' }}>{v.tagline}</span></div></>) : (<><div style={{ height: '150px', borderRadius: '28px', background: 'repeating-linear-gradient(135deg,#14121E 0 10px,#1C1A29 10px 20px)', border: '1px solid #2A2640', display: 'grid', placeItems: 'center' }}>
<span title={v.tagline} style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: '12px', color: '#8C87A3', background: '#0B0A12', padding: '4px 12px', borderRadius: '999px', whiteSpace: 'nowrap', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', boxSizing: 'border-box' }}>{v.tagline}</span>
</div></>)}
<div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: '9px' }}>
<div style={{ background: '#14121E', border: '1px solid #2E2A45', borderRadius: '24px', padding: '13px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
<span style={{ fontSize: '11px', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: "'JetBrains Mono',monospace", color: '#8C87A3' }}>Price USD</span>
<span style={{ fontFamily: 'Inter,system-ui,sans-serif', fontWeight: '700', letterSpacing: '-0.01em', fontSize: '21px' }}>{v.priceUsd}</span>
</div>
<div style={{ background: '#14121E', border: '1px solid #2E2A45', borderRadius: '24px', padding: '13px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
<span style={{ fontSize: '11px', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: "'JetBrains Mono',monospace", color: '#8C87A3' }}>Price</span>
<span style={{ fontFamily: 'Inter,system-ui,sans-serif', fontWeight: '700', letterSpacing: '-0.01em', fontSize: '17px', whiteSpace: 'nowrap' }}>{v.priceNum}</span>
</div>
</div>
<div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: '9px' }}>
{(v.keyStats ?? []).map((s: any, sI: number) => (<Fragment key={sI}>
<div style={{ background: '#14121E', border: '1px solid #2E2A45', borderRadius: '24px', padding: '13px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
<span style={{ fontSize: '11px', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: "'JetBrains Mono',monospace", color: '#8C87A3' }}>{s.label}</span>
<span style={{ fontFamily: 'Inter,system-ui,sans-serif', fontWeight: '700', letterSpacing: '-0.01em', fontSize: '21px' }}>{s.value}</span>
</div>
</Fragment>))}
</div>
<div style={{ background: '#14121E', border: '1px solid #2E2A45', borderRadius: '32px', padding: '13px', display: 'flex', flexDirection: 'column', gap: '18px' }}>
<div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: '4px', background: '#1C1A29', borderRadius: '999px', padding: '4px' }}>
{(v.windows ?? []).map((w: any, wI: number) => (<Fragment key={wI}>
<button onClick={w.select} style={{ border: '0', cursor: 'pointer', borderRadius: '999px', padding: '6px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1px', background: w.bg, fontFamily: 'Inter,system-ui,sans-serif' }}>
<span style={{ fontSize: '11px', color: '#8C87A3', fontWeight: '600' }}>{w.label}</span>
<span style={{ fontSize: '14px', fontWeight: '700', whiteSpace: 'nowrap', color: w.fg }}>{w.change}</span>
</button>
</Fragment>))}
</div>
{(v.flows ?? []).map((f: any, fI: number) => (<Fragment key={fI}>
<div style={{ display: 'grid', gridTemplateColumns: '84px minmax(0,1fr)', gap: '13px', alignItems: 'end', padding: '0 9px' }}>
<div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
<span style={{ fontSize: '11px', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: "'JetBrains Mono',monospace", color: '#8C87A3' }}>{f.label}</span>
<span style={{ fontFamily: 'Inter,system-ui,sans-serif', fontWeight: '700', letterSpacing: '-0.01em', fontSize: '20px', lineHeight: '1.1' }}>{f.total}</span>
</div>
<div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
<div style={{ display: 'flex', justifyContent: 'space-between', gap: '9px', fontSize: '12px', whiteSpace: 'nowrap' }}>
<span style={{ color: '#8C87A3', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{f.aLabel}</span>
<span style={{ color: '#8C87A3', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{f.bLabel}</span>
</div>
<div style={{ display: 'flex', justifyContent: 'space-between', gap: '9px', fontSize: '15px', fontWeight: '700', whiteSpace: 'nowrap', fontFamily: "'JetBrains Mono',monospace", fontVariantNumeric: 'tabular-nums' }}>
<span style={{ color: '#6EE7B7' }}>{f.aVal}</span>
<span style={{ color: '#FCA5A5' }}>{f.bVal}</span>
</div>
<div style={{ display: 'flex', gap: '4px', height: '8px' }}>
<div style={{ flex: f.a, background: '#34D399', borderRadius: '999px' }}></div>
<div style={{ flex: f.b, background: '#F87171', borderRadius: '999px' }}></div>
</div>
</div>
</div>
</Fragment>))}
</div>
<div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: '9px' }}>
</div>
{v.swap}
</aside>
</div>
<SiteFooter />
</div>
  );
}

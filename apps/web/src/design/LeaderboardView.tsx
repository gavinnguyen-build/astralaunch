// GENERATED from docs/design/Leaderboard.dc.html by apps/web/scripts/dc2tsx.py, then wired to real data.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Fragment } from 'react';
import { A } from '../components/A.js';
import { SiteHeader, SiteFooter } from '../components/Site.js';
import './LeaderboardView.css';

export function LeaderboardView({ v }: { v: any }) {
  return (
<div style={{ width: '1440px', minHeight: '1120px', boxSizing: 'border-box', background: '#0B0A12', color: '#ECEAF4', fontFamily: 'Inter, system-ui, sans-serif', fontVariantNumeric: 'tabular-nums', display: 'flex', flexDirection: 'column' }}>
<SiteHeader active='leaderboard' />
<main style={{ padding: '32px 124px 44px', display: 'flex', flexDirection: 'column', gap: '22px' }}>
<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '20px' }}>
<div><h1 style={{ margin: '0', fontSize: '34px', fontWeight: '800', letterSpacing: '-0.02em' }}>Leaderboard</h1><p style={{ margin: '8px 0 0', fontSize: '15px', color: '#A7A2BD' }}>{v.subtitle}</p></div>
<div role="group" aria-label="Period" style={{ display: 'flex', gap: '4px', padding: '4px', borderRadius: '999px', background: '#13111C', border: '1px solid #25213A' }}>
{(v.periods ?? []).map((p: any, pI: number) => (<Fragment key={pI}><button type="button" aria-pressed={p.on} onClick={p.pick} style={{ height: '34px', padding: '0 16px', borderRadius: '999px', border: '0', background: p.bg, color: p.fg, fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', fontWeight: '600', cursor: 'pointer' }}>{p.label}</button></Fragment>))}
</div>
</div>
<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px' }}>
<div role="tablist" aria-label="Leaderboard group" style={{ display: 'flex', gap: '4px', padding: '4px', borderRadius: '14px', background: '#13111C', border: '1px solid #25213A' }}>
{(v.groups ?? []).map((g: any, gI: number) => (<Fragment key={gI}><button type="button" role="tab" aria-selected={g.on} onClick={g.pick} style={{ height: '44px', padding: '0 22px', borderRadius: '10px', border: '0', background: g.bg, color: g.fg, fontFamily: 'inherit', fontSize: '15px', fontWeight: '700', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '10px' }}>{g.label}<span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', padding: '2px 8px', borderRadius: '999px', background: g.countBg, color: g.countFg }}>{g.count}</span></button></Fragment>))}
</div>
<div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><span style={{ fontSize: '13px', color: '#8C87A3' }}>Rank by</span>
{(v.sorts ?? []).map((s: any, sI: number) => (<Fragment key={sI}><button type="button" aria-pressed={s.on} onClick={s.pick} style={{ height: '34px', padding: '0 14px', borderRadius: '999px', border: s.border, background: s.bg, color: s.fg, fontFamily: 'inherit', fontSize: '13px', cursor: 'pointer' }}>{s.label}</button></Fragment>))}
</div>
</div>
<div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: '16px' }}>
{v.listState}
{(v.podium ?? []).map((p: any, pI: number) => (<Fragment key={pI}>
<A href={p.href} style={{ border: p.border, borderRadius: '20px', background: p.bg, padding: '22px', display: 'flex', flexDirection: 'column', gap: '16px', color: '#ECEAF4', textDecoration: 'none' }}>
<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
<div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}><span style={{ width: '44px', height: '44px', borderRadius: '12px', background: p.avatar, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px', fontWeight: '800', color: '#FFFFFF' }}>{p.initial}</span><span><span style={{ display: 'block', fontSize: '16px', fontWeight: '700' }}>{p.name}</span><span style={{ display: 'block', fontSize: '12px', color: '#A7A2BD' }}>{p.sub}</span></span></div>
<span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '13px', fontWeight: '700', padding: '6px 10px', borderRadius: '999px', background: p.rankBg, color: p.rankFg }}>#{p.rank}</span>
</div>
<div><div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '10px', letterSpacing: '0.14em', color: '#8C87A3' }}><br /></div><div style={{ marginTop: '6px', fontSize: '30px', fontWeight: '800', letterSpacing: '-0.02em', color: p.metricColor }}>{p.metric}</div></div>
<dl style={{ margin: '0', display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: '10px', paddingTop: '14px', borderTop: '1px solid #25213A' }}>
{(p.facts ?? []).map((f: any, fI: number) => (<Fragment key={fI}><div><dt style={{ fontSize: '11px', color: '#8C87A3' }}>{f.k}</dt><dd style={{ margin: '4px 0 0', fontFamily: "'JetBrains Mono', monospace", fontSize: '13px', fontWeight: '600' }}>{f.v}</dd></div></Fragment>))}
</dl>
</A>
</Fragment>))}
</div>
<section aria-label="Rankings" style={{ border: '1px solid #25213A', borderRadius: '16px', background: '#13111C', padding: '8px 20px 12px' }}>
<div style={{ display: 'grid', gridTemplateColumns: v.cols, gap: '12px', padding: '12px 8px', borderBottom: '1px solid #25213A', fontFamily: "'JetBrains Mono', monospace", fontSize: '10px', letterSpacing: '0.12em', color: '#8C87A3' }}>
{(v.heads ?? []).map((h: any, hI: number) => (<Fragment key={hI}><span style={{ textAlign: h.align }}>{h.label}</span></Fragment>))}
</div>
{(v.rows ?? []).map((r: any, rI: number) => (<Fragment key={rI}>
<A href={r.href} style={{ display: 'grid', gridTemplateColumns: v.cols, gap: '12px', alignItems: 'center', padding: '11px 8px', borderBottom: '1px solid #1E1B2E', color: '#ECEAF4', textDecoration: 'none', fontSize: '13px', background: r.bg }}>
<span style={{ fontFamily: "'JetBrains Mono', monospace", color: '#8C87A3' }}>{r.rank}</span>
<span style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: '0' }}><span style={{ width: '30px', height: '30px', flexShrink: '0', borderRadius: '8px', background: r.avatar, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: '800', color: '#FFFFFF' }}>{r.initial}</span><span style={{ minWidth: '0' }}><span style={{ display: 'block', fontWeight: '700' }}>{r.name}</span><span style={{ display: 'block', fontSize: '12px', color: '#8C87A3', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.sub}</span></span></span>
{(r.cells ?? []).map((c: any, cI: number) => (<Fragment key={cI}><span style={{ textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color: c.color }}>{c.v}</span></Fragment>))}
</A>
</Fragment>))}
{v.me ? (<><div style={{ display: 'grid', gridTemplateColumns: v.cols, gap: '12px', alignItems: 'center', marginTop: '10px', padding: '12px 8px', borderRadius: '12px', border: '1px solid #8B5CF6', background: '#1B1530', fontSize: '13px' }}>
<span style={{ fontFamily: "'JetBrains Mono', monospace", color: '#C4B5FD' }}>{v.me.rank}</span>
<span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}><span style={{ width: '30px', height: '30px', borderRadius: '8px', background: '#2A2640', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: '800' }}>You</span><span><span style={{ display: 'block', fontWeight: '700' }}>{v.me.addr}</span><span style={{ display: 'block', fontSize: '12px', color: '#A7A2BD' }}>{v.me.sub}</span></span></span>
{(v.me.cells ?? []).map((c: any, cI: number) => (<Fragment key={cI}><span style={{ textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color: c.color }}>{c.v}</span></Fragment>))}
</div></>) : null}
</section>
</main>
<SiteFooter />
</div>
  );
}

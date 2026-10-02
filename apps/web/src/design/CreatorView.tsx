// GENERATED from docs/design/Creator.dc.html by apps/web/scripts/dc2tsx.py, then wired to real data.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Fragment } from 'react';
import { A, route } from '../components/A.js';
import { SiteHeader, SiteFooter } from '../components/Site.js';
import './CreatorView.css';

export function CreatorView({ v }: { v: any }) {
  return (
<div style={{ width: '1440px', minHeight: '1120px', boxSizing: 'border-box', background: '#0B0A12', color: '#ECEAF4', fontFamily: 'Inter, system-ui, sans-serif', fontVariantNumeric: 'tabular-nums', display: 'flex', flexDirection: 'column' }}>
<SiteHeader active='creator' />
<main style={{ padding: '36px 124px 44px', display: 'grid', gridTemplateColumns: '280px minmax(0,1fr)', gap: '28px', alignItems: 'start' }}>
<nav aria-label="Your tokens" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
<h1 style={{ margin: '0 0 6px', fontSize: '30px', fontWeight: '800', letterSpacing: '-0.02em' }}>Creator</h1>
<p style={{ margin: '0 0 10px', fontSize: '13px', color: '#8C87A3' }}>{v.wallet}</p>
{(v.tokens ?? []).map((t: any, tI: number) => (<Fragment key={tI}><A href={t.href} onClick={t.pick} aria-current={t.on ? 'page' : undefined} style={t.on ? { display: 'flex', alignItems: 'center', gap: '12px', padding: '14px', borderRadius: '14px', border: '1px solid #8B5CF6', background: '#1B1530', color: '#ECEAF4', textDecoration: 'none' } : { display: 'flex', alignItems: 'center', gap: '12px', padding: '14px', borderRadius: '14px', border: '1px solid #25213A', background: '#13111C', color: '#ECEAF4', textDecoration: 'none' }}>{t.avatarNode}<span><span style={{ display: 'block', fontWeight: '700' }}>{t.sym}</span><span style={{ display: 'block', fontSize: '12px', color: '#A7A2BD' }}>{t.sub}</span></span></A></Fragment>))}
<A href={route('Launch')} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '48px', borderRadius: '14px', border: '1px dashed #5B5475', color: '#C9C5DA', textDecoration: 'none', fontSize: '14px', fontWeight: '600' }}>Launch another token</A>
</nav>
<div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>
<div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: '16px' }}>
{(v.claims ?? []).map((c: any, cI: number) => (<Fragment key={cI}>
<section style={{ border: c.border, borderRadius: '16px', background: c.bg, padding: '20px', display: 'flex', flexDirection: 'column', gap: '12px', minHeight: '290px', boxSizing: 'border-box' }}>
<div><h2 style={{ margin: '0', fontSize: '15px', fontWeight: '700' }}>{c.title}</h2><p style={{ margin: '6px 0 0', fontSize: '12px', lineHeight: '1.5', color: '#A7A2BD' }}>{c.sub}</p></div>
<div style={{ fontSize: '30px', fontWeight: '800', letterSpacing: '-0.02em', color: c.color }}>{c.big}</div>
<dl style={{ margin: '0', display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px' }}>
{(c.lines ?? []).map((l: any, lI: number) => (<Fragment key={lI}>
<div style={{ display: 'flex', justifyContent: 'space-between' }}><dt style={{ color: '#8C87A3' }}>{l.k}</dt><dd style={{ margin: '0', fontFamily: "'JetBrains Mono', monospace" }}>{l.v}</dd></div>
</Fragment>))}
</dl>
<button type="button" onClick={c.onClick} disabled={c.disabled} title={c.btnTitle} style={{ marginTop: 'auto', height: '46px', borderRadius: '999px', border: c.btnBorder, background: c.btnBg, color: '#FFFFFF', fontFamily: 'inherit', fontSize: '14px', fontWeight: '700', cursor: 'pointer' }}>{c.cta}</button>
</section>
</Fragment>))}
</div>
<section aria-labelledby="svc" style={{ border: '1px solid #25213A', borderRadius: '16px', background: '#13111C', padding: '24px', display: 'flex', flexDirection: 'column', gap: '18px' }}>
<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><h2 id="svc" style={{ margin: '0', fontSize: '18px', fontWeight: '700' }}>Service</h2><span style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: v.svcColor }}><span style={{ width: '8px', height: '8px', borderRadius: '50%', background: v.svcColor }}></span>{v.svcStatus}</span></div>
{v.serviceForm}
<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px' }}><p style={{ margin: '0', fontSize: '13px', color: '#A7A2BD' }}>Changes are signed by your wallet and shown publicly on the token page.</p><button type="button" onClick={v.onSave} disabled={v.saveDisabled} title={v.saveTitle} style={{ height: '44px', padding: '0 20px', borderRadius: '999px', border: '1px solid #3A3456', background: 'transparent', color: '#ECEAF4', fontFamily: 'inherit', fontSize: '14px', fontWeight: '700', cursor: 'pointer' }}>Sign and save</button></div>
<div>
<div style={{ display: 'grid', gridTemplateColumns: '110px 80px 110px 120px minmax(0,1fr)', gap: '12px', padding: '10px 0', borderBottom: '1px solid #25213A', fontFamily: "'JetBrains Mono', monospace", fontSize: '10px', letterSpacing: '0.12em', color: '#8C87A3' }}><span>TIME</span><span>STATUS</span><span style={{ textAlign: 'right' }}>LATENCY</span><span>CHARGED</span><span>NOTE</span></div>
{v.logsState}
{(v.logs ?? []).map((l: any, lI: number) => (<Fragment key={lI}>
<div style={{ display: 'grid', gridTemplateColumns: '110px 80px 110px 120px minmax(0,1fr)', gap: '12px', padding: '11px 0', borderBottom: '1px solid #1E1B2E', fontSize: '13px', alignItems: 'center' }}><span style={{ fontFamily: "'JetBrains Mono', monospace", color: '#8C87A3' }}>{l.t}</span><span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: '700', color: l.color }}>{l.s}</span><span style={{ textAlign: 'right', fontFamily: "'JetBrains Mono', monospace" }}>{l.lat}</span><span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{l.ch}</span><span style={{ color: '#A7A2BD' }}>{l.note}</span></div>
</Fragment>))}
</div>
</section>
{v.imageCard}
{v.protectCard}
</div>
</main>
{v.modal}
<SiteFooter />
</div>
  );
}

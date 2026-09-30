// GENERATED from docs/design/Launch.dc.html by apps/web/scripts/dc2tsx.py, then wired to real data.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Fragment } from 'react';
import { A, route } from '../components/A.js';
import { SiteHeader, SiteFooter } from '../components/Site.js';
import './LaunchView.css';

export function LaunchView({ v }: { v: any }) {
  return (
<div style={{ width: '1440px', minHeight: '1960px', boxSizing: 'border-box', background: '#0B0A12', color: '#ECEAF4', fontFamily: 'Inter, system-ui, sans-serif', fontVariantNumeric: 'tabular-nums', display: 'flex', flexDirection: 'column' }}>
<SiteHeader active='' />
<main style={{ padding: '36px 124px 44px', display: 'flex', justifyContent: 'center' }}>
<form style={{ width: '760px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
<div>
<h1 style={{ margin: '0', fontSize: '40px', fontWeight: '800', letterSpacing: '-0.02em' }}>Launch your token</h1>
<p style={{ margin: '10px 0 0', maxWidth: '600px', fontSize: '16px', lineHeight: '1.6', color: '#A7A2BD' }}>One transaction creates the token and its pool on Monad. Attach an API now or later: every paid call buys back your token.</p>
</div>
<section style={{ border: '1px solid #25213A', borderRadius: '16px', background: '#13111C', padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
<h2 style={{ margin: '0', fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', letterSpacing: '0.16em', fontWeight: '500', color: '#B9A8E8' }}>TOKEN</h2>
<label style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '14px', fontWeight: '600' }}>Token name<input type="text" value={v.f.name.value} onChange={v.f.name.onChange} maxLength={32} placeholder="Enter token name…" style={{ height: '48px', boxSizing: 'border-box', padding: '0 14px', border: '1px solid #2A2640', borderRadius: '10px', background: '#0E0D16', color: '#ECEAF4', fontFamily: 'inherit', fontSize: '15px', width: '100%', borderColor: '#8B5CF6' }} /></label>
<div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}><label style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '14px', fontWeight: '600' }}><span>Ticker symbol</span><input type="text" value={v.f.symbol.value} onChange={v.f.symbol.onChange} maxLength={10} placeholder="e.g. SIGHT" style={{ height: '48px', boxSizing: 'border-box', padding: '0 14px', border: '1px solid #2A2640', borderRadius: '10px', background: '#0E0D16', color: '#ECEAF4', fontFamily: "'JetBrains Mono', monospace", fontSize: '15px', width: '100%' }} /></label></div>
<div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '14px', fontWeight: '600' }}><label htmlFor="img">Token image (optional)</label><div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 48px', gap: '10px' }}><input id="img" type="url" value={v.f.imageUrl.value} onChange={v.f.imageUrl.onChange} placeholder="Paste image URL or upload…" style={{ height: '48px', boxSizing: 'border-box', padding: '0 14px', border: '1px solid #2A2640', borderRadius: '10px', background: '#0E0D16', color: '#ECEAF4', fontFamily: 'inherit', fontSize: '15px', width: '100%' }} /><button type="button" aria-label="Upload image" disabled title="Upload is not available yet; paste an image URL" style={{ height: '48px', borderRadius: '10px', border: '1px solid #2A2640', background: '#0E0D16', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#C9C5DA" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.5l-8.5 8.5a5 5 0 0 1-7-7l9-9a3.3 3.3 0 0 1 4.7 4.7l-9 9a1.7 1.7 0 0 1-2.4-2.4l8.3-8.3"></path></svg></button></div></div>
<div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}><label style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '14px', fontWeight: '600' }}>Your X account (optional)<input type="text" value={v.f.xHandle.value} onChange={v.f.xHandle.onChange} placeholder="@handle" style={{ height: '48px', boxSizing: 'border-box', padding: '0 14px', border: '1px solid #2A2640', borderRadius: '10px', background: '#0E0D16', color: '#ECEAF4', fontFamily: 'inherit', fontSize: '15px', width: '100%' }} /></label><p style={{ margin: '0', fontSize: '13px', color: '#8C87A3' }}>Shown on the token page so holders know who runs the service.</p></div>
<label style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '14px', fontWeight: '600' }}>Website (optional)<input type="url" value={v.f.website.value} onChange={v.f.website.onChange} placeholder="https://yourproject.com" style={{ height: '48px', boxSizing: 'border-box', padding: '0 14px', border: '1px solid #2A2640', borderRadius: '10px', background: '#0E0D16', color: '#ECEAF4', fontFamily: 'inherit', fontSize: '15px', width: '100%' }} /></label>
</section>
<section style={{ border: '1px solid #25213A', borderRadius: '16px', background: '#13111C', padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
<h2 style={{ margin: '0', fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', letterSpacing: '0.16em', fontWeight: '500', color: '#B9A8E8' }}>MARKET</h2>
<div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}><span style={{ fontSize: '14px', fontWeight: '600' }}>Pool pairing</span><div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: '10px' }}>
{(v.pairings ?? []).map((o: any, oI: number) => (<Fragment key={oI}>
<button type="button" aria-pressed={o.on} onClick={o.pick} aria-disabled={o.ariaDis} style={{ height: '48px', borderRadius: '10px', border: o.border, background: o.bg, color: o.fg, fontFamily: 'inherit', fontSize: '14px', fontWeight: '600', cursor: o.cursor, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>{o.label}{o.soon ? (<><span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '10px', padding: '2px 6px', borderRadius: '999px', border: '1px solid #3A3456', color: '#8C87A3' }}>SOON</span></>) : null}</button>
</Fragment>))}
</div><p style={{ margin: '0', fontSize: '13px', color: '#8C87A3' }}>{v.pairHint}</p></div>
<div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}><span style={{ fontSize: '14px', fontWeight: '600' }}>Creator vesting</span><div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: '10px' }}>
{(v.vesting ?? []).map((o: any, oI: number) => (<Fragment key={oI}>
<button type="button" aria-pressed={o.on} onClick={o.pick} aria-disabled={o.ariaDis} style={{ height: '48px', borderRadius: '10px', border: o.border, background: o.bg, color: o.fg, fontFamily: 'inherit', fontSize: '14px', fontWeight: '600', cursor: o.cursor, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>{o.label}{o.soon ? (<><span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '10px', padding: '2px 6px', borderRadius: '999px', border: '1px solid #3A3456', color: '#8C87A3' }}>SOON</span></>) : null}</button>
</Fragment>))}
</div><p style={{ margin: '0', fontSize: '13px', color: '#8C87A3' }}>15% of the supply vests to your wallet over 1 year with a 30-day cliff.</p></div>
</section>
<section style={{ border: '1px solid #25213A', borderRadius: '16px', background: '#13111C', padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
<h2 style={{ margin: '0', fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', letterSpacing: '0.16em', fontWeight: '500', color: '#B9A8E8' }}>SERVICE (OPTIONAL)</h2>
<div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: '10px' }}>
{(v.services ?? []).map((o: any, oI: number) => (<Fragment key={oI}>
<button type="button" aria-pressed={o.on} onClick={o.pick} aria-disabled={o.ariaDis} style={{ height: '48px', borderRadius: '10px', border: o.border, background: o.bg, color: o.fg, fontFamily: 'inherit', fontSize: '14px', fontWeight: '600', cursor: o.cursor, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>{o.label}{o.soon ? (<><span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '10px', padding: '2px 6px', borderRadius: '999px', border: '1px solid #3A3456', color: '#8C87A3' }}>SOON</span></>) : null}</button>
</Fragment>))}
</div>
{v.hasApi ? (<>
<div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 180px', gap: '14px' }}>
<label style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '14px', fontWeight: '600' }}>Upstream URL<input type="url" value={v.f.upstream.value} onChange={v.f.upstream.onChange} placeholder="https://your-api.example/v1/signals" style={{ height: '48px', boxSizing: 'border-box', padding: '0 14px', border: '1px solid #2A2640', borderRadius: '10px', background: '#0E0D16', color: '#ECEAF4', fontFamily: 'inherit', fontSize: '15px', width: '100%' }} /></label>
<label style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '14px', fontWeight: '600' }}>Price per call (USDC)<input type="text" inputMode="decimal" value={v.f.price.value} onChange={v.f.price.onChange} style={{ height: '48px', boxSizing: 'border-box', padding: '0 14px', border: '1px solid #2A2640', borderRadius: '10px', background: '#0E0D16', color: '#ECEAF4', fontFamily: "'JetBrains Mono', monospace", fontSize: '15px', width: '100%' }} /></label>
<label style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '14px', fontWeight: '600' }}>Health check path<input type="text" defaultValue="/health" disabled title="Health checks are not configurable yet" style={{ height: '48px', boxSizing: 'border-box', padding: '0 14px', border: '1px solid #2A2640', borderRadius: '10px', background: '#0E0D16', color: '#ECEAF4', fontFamily: "'JetBrains Mono', monospace", fontSize: '15px', width: '100%' }} /></label>
<label style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '14px', fontWeight: '600' }}>Method<select disabled title="The gateway forwards the method the agent uses" style={{ height: '48px', boxSizing: 'border-box', padding: '0 14px', border: '1px solid #2A2640', borderRadius: '10px', background: '#0E0D16', color: '#ECEAF4', fontFamily: 'inherit', fontSize: '15px', width: '100%' }}><option>GET</option><option>POST</option></select></label>
</div>
<label style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '14px', fontWeight: '600' }}>Example call<input type="text" value={v.f.example.value} onChange={v.f.example.onChange} placeholder="/price?token=MON" spellCheck={false} style={{ height: '48px', boxSizing: 'border-box', padding: '0 14px', border: '1px solid #2A2640', borderRadius: '10px', background: '#0E0D16', color: '#ECEAF4', fontFamily: "'JetBrains Mono', monospace", fontSize: '15px', width: '100%' }} /><span style={{ fontSize: '13px', fontWeight: '400', color: '#8C87A3' }}>One real request to your API, e.g. /price?token=MON</span></label>
<p style={{ margin: '0', fontSize: '13px', color: '#8C87A3' }}>The gateway signs every forwarded request. Reject unsigned calls so all paid traffic goes through Astralaunch.</p>
</>) : null}
{v.later ? (<><p style={{ margin: '0', fontSize: '13px', color: '#8C87A3' }}>Your token trades right away. Escrowed fees wait for a service and go to buyback after 365 days if none earns.</p></>) : null}
</section>
<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px', padding: '14px 16px', border: '1px solid #25213A', borderRadius: '12px', background: '#0E0D16' }}><div><div style={{ fontSize: '14px', fontWeight: '600' }}>Launch fee</div><div style={{ marginTop: '4px', fontSize: '13px', color: '#8C87A3' }}>{v.feeNote}</div></div><span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '15px', whiteSpace: 'nowrap' }}>10 MON</span></div>
<div style={{ position: 'sticky', bottom: '0', display: 'grid', gridTemplateColumns: '1fr 1.6fr', gap: '12px', padding: '16px 0', borderTop: '1px solid #25213A', background: '#0B0A12' }}>
<A href={route('Main')} onClick={v.onCancel} style={{ height: '52px', borderRadius: '12px', background: '#1C1A29', color: '#ECEAF4', fontSize: '15px', fontWeight: '700', display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' }}>Cancel</A>
<button type="button" onClick={v.onLaunch} disabled={v.launchDisabled} title={v.launchTitle} style={{ height: '52px', borderRadius: '12px', border: '0', background: '#8B5CF6', color: '#FFFFFF', fontFamily: 'inherit', fontSize: '15px', fontWeight: '700', cursor: 'pointer' }}>{v.launchLabel}</button>
</div>
</form>
</main>
{v.formErrors}
{v.overlay}
<SiteFooter />
</div>
  );
}

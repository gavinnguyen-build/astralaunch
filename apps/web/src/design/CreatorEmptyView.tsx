// GENERATED from docs/design/CreatorEmpty.dc.html by apps/web/scripts/dc2tsx.py, then wired to real data.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { A, route } from '../components/A.js';
import { SiteHeader, SiteFooter } from '../components/Site.js';
import './CreatorEmptyView.css';

export function CreatorEmptyView(_props: { v?: any }) {
  return (
<div style={{ width: '1440px', minHeight: '900px', boxSizing: 'border-box', background: '#0B0A12', color: '#ECEAF4', fontFamily: 'Inter, system-ui, sans-serif', fontVariantNumeric: 'tabular-nums', display: 'flex', flexDirection: 'column' }}>
<SiteHeader active='creator' />
<main style={{ padding: '64px 124px 64px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
<section aria-labelledby="empty" style={{ width: '760px', boxSizing: 'border-box', border: '1px solid #3A3456', borderRadius: '24px', padding: '48px 56px', background: 'radial-gradient(600px 300px at 50% 110%, rgba(168,85,247,0.28), transparent 65%), #110F1A', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '22px', textAlign: 'center' }}>
<img src={'/astralaunch-logo.png'} alt="" width="72" height="72" style={{ width: '72px', height: '72px', display: 'block' }} />
<div>
<h1 id="empty" style={{ margin: '0', fontSize: '34px', fontWeight: '800', letterSpacing: '-0.02em' }}>You have not launched a token yet</h1>
<p style={{ margin: '12px auto 0', maxWidth: '520px', fontSize: '16px', lineHeight: '1.6', color: '#A7A2BD', width: '555px', height: '83px' }}>Launch a token for your service and earn from both sides: trading fees from day one, and usage fees every time an agent pays for your API.</p>
</div>
<A href={route('Launch')} style={{ height: '52px', boxSizing: 'border-box', padding: '0 28px', borderRadius: '999px', background: '#8B5CF6', color: '#FFFFFF', fontSize: '16px', fontWeight: '700', display: 'flex', alignItems: 'center', gap: '10px', textDecoration: 'none' }}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 15c-1 1-1.5 3.5-1.5 5.5 2 0 4.5-.5 5.5-1.5M14 4c3 0 6 3 6 6l-7 7-6-6 7-7zM9 11l-3 1-2 3 3 1M13 15l-1 3-3 2-1-3"></path></svg>Launch your token</A>
<div style={{ width: '100%', marginTop: '10px', paddingTop: '24px', borderTop: '1px solid #25213A', display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: '12px', textAlign: 'left' }}>
<div style={{ padding: '16px', border: '1px solid #25213A', borderRadius: '14px', background: '#13111C' }}><div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '18px', fontWeight: '700', color: '#C4B5FD' }}>0.70%</div><div style={{ marginTop: '6px', fontSize: '13px', lineHeight: '1.5', color: '#A7A2BD' }}>of every trade, claim anytime</div></div>
<div style={{ padding: '16px', border: '1px solid #25213A', borderRadius: '14px', background: '#13111C' }}><div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '18px', fontWeight: '700', color: '#34D399' }}>60%</div><div style={{ marginTop: '6px', fontSize: '13px', lineHeight: '1.5', color: '#A7A2BD' }}>of every paid API call, plus escrow unlocked by usage</div></div>
<div style={{ padding: '16px', border: '1px solid #25213A', borderRadius: '14px', background: '#13111C' }}><div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '18px', fontWeight: '700', color: '#ECEAF4' }}>15%</div><div style={{ marginTop: '6px', fontSize: '13px', lineHeight: '1.5', color: '#A7A2BD' }}>of supply vested to you over one year</div></div>
</div>
<p style={{ margin: '0', fontSize: '13px', color: '#8C87A3' }}>Launch fee 10 MON, plus Monad gas.</p>
</section>
</main>
<SiteFooter />
</div>
  );
}

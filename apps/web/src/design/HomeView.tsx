// GENERATED from docs/design/Home.dc.html by apps/web/scripts/dc2tsx.py, then wired to real data.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Fragment } from 'react';
import { A, route } from '../components/A.js';
import { SiteHeader, SiteFooter } from '../components/Site.js';
import { CopyButton } from '../components/CopyButton.js';
import './HomeView.css';

export function HomeView({ v }: { v: any }) {
  return (
<div style={{ width: '1440px', minHeight: '2160px', boxSizing: 'border-box', background: '#0B0A12', color: '#ECEAF4', fontFamily: 'Inter, system-ui, sans-serif', display: 'flex', flexDirection: 'column' }}>
<SiteHeader active='discover' />
<main style={{ padding: '26px 124px 0', display: 'flex', flexDirection: 'column', gap: '20px' }}>
<section style={{ border: '1px solid #2A2640', borderRadius: '24px', overflow: 'hidden', background: 'radial-gradient(900px 420px at 80% 70%, rgba(168,85,247,0.28), transparent 60%), radial-gradient(700px 380px at 95% 10%, rgba(99,102,241,0.18), transparent 60%), #110F1A' }}>
<div style={{ height: '532px', boxSizing: 'border-box', padding: '70px 40px 0', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 460px', gap: '40px' }}>
<div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>
<span style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 12px 4px 4px', border: '1px solid #3A3456', borderRadius: '999px', fontSize: '13px', color: '#D4D0E4' }}><span style={{ padding: '2px 8px', borderRadius: '999px', background: '#6D4AE0', color: '#FFFFFF', fontFamily: "'JetBrains Mono', monospace", fontSize: '10px', fontWeight: '600' }}>LIVE</span>Now on Monad mainnet</span>
<h1 style={{ margin: '0', fontSize: '48px', lineHeight: '1.08', letterSpacing: '-0.02em', fontWeight: '800' }}>Agents are <span style={{ background: 'linear-gradient(90deg,#A78BFA,#E879F9)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', WebkitBoxDecorationBreak: 'clone', boxDecorationBreak: 'clone' }}>the new customers</span>. Build what they pay for.</h1>
<p style={{ margin: '0', maxWidth: '520px', fontSize: '16px', lineHeight: '1.6', color: '#A7A2BD' }}>Agents don't browse, sign up, or subscribe. They call, and they pay. Astralaunch is the launchpad for the businesses they'll rely on: permissionless, onchain, and owned by the people who believe in them early.</p>
<div style={{ display: 'flex', gap: '12px', marginTop: '8px' }}>
<A href={route('Launch')} style={{ height: '48px', boxSizing: 'border-box', padding: '0 24px', borderRadius: '999px', background: '#8B5CF6', color: '#FFFFFF', fontSize: '15px', fontWeight: '700', display: 'flex', alignItems: 'center', gap: '10px', textDecoration: 'none' }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 15c-1 1-1.5 3.5-1.5 5.5 2 0 4.5-.5 5.5-1.5M14 4c3 0 6 3 6 6l-7 7-6-6 7-7zM9 11l-3 1-2 3 3 1M13 15l-1 3-3 2-1-3"></path></svg>Launch Now</A>
<A href={route('Discover')} style={{ height: '48px', padding: '0 22px', borderRadius: '999px', border: '1px solid #3A3456', background: 'transparent', color: '#ECEAF4', textDecoration: 'none', boxSizing: 'border-box', fontSize: '15px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>Explore <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#ECEAF4" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"></path></svg></A>
</div>
</div>
<div role="img" aria-label="Pixel-art robots at desks, server racks and a wall screen showing a live x402 payment" style={{ position: 'relative', height: '462px' }} className="px-stage">
<div style={{ position: 'absolute', left: '-73px', top: '-38px', width: '610px', height: '507px' }}>
<div style={{ position: 'absolute', left: '15.8px', top: '19.8px', width: '209.1px', height: '196.3px', zIndex: '1', backgroundImage: 'url(/robots-atlas.png)', backgroundRepeat: 'no-repeat', backgroundSize: '460.0px 439.1px', backgroundPosition: '-0.0px -0.0px' }} className="px-piece px-breathe"></div>
<div style={{ position: 'absolute', left: '287.6px', top: '27.9px', width: '163.6px', height: '194.4px', zIndex: '1', backgroundImage: 'url(/robots-atlas.png)', backgroundRepeat: 'no-repeat', backgroundSize: '460.0px 439.1px', backgroundPosition: '-209.8px -0.0px' }} className="px-piece px-breathe px-d2"></div>
<div style={{ position: 'absolute', left: '171.7px', top: '207.6px', width: '129.9px', height: '141.2px', zIndex: '3', backgroundImage: 'url(/robots-atlas.png)', backgroundRepeat: 'no-repeat', backgroundSize: '460.0px 439.1px', backgroundPosition: '-0.0px -197.0px' }} className="px-piece px-bob"></div>
<div style={{ position: 'absolute', left: '308.5px', top: '246.5px', width: '125.1px', height: '138.3px', zIndex: '3', backgroundImage: 'url(/robots-atlas.png)', backgroundRepeat: 'no-repeat', backgroundSize: '460.0px 439.1px', backgroundPosition: '-130.6px -197.0px' }} className="px-piece px-bob px-d2"></div>
<div style={{ position: 'absolute', left: '36.7px', top: '223.8px', width: '117.8px', height: '133.2px', zIndex: '3', backgroundImage: 'url(/robots-atlas.png)', backgroundRepeat: 'no-repeat', backgroundSize: '460.0px 439.1px', backgroundPosition: '-256.4px -197.0px' }} className="px-piece px-bob px-d1"></div>
<div style={{ position: 'absolute', left: '250.2px', top: '356.6px', width: '66.4px', height: '81.8px', zIndex: '3', backgroundImage: 'url(/robots-atlas.png)', backgroundRepeat: 'no-repeat', backgroundSize: '460.0px 439.1px', backgroundPosition: '-374.9px -197.0px' }} className="px-piece px-breathe px-d1"></div>
<div style={{ position: 'absolute', left: '36.7px', top: '356.6px', width: '50.6px', height: '73.7px', zIndex: '4', backgroundImage: 'url(/robots-atlas.png)', backgroundRepeat: 'no-repeat', backgroundSize: '460.0px 439.1px', backgroundPosition: '-0.0px -338.9px' }} className="px-piece px-hover"></div>
<div style={{ position: 'absolute', left: '344.8px', top: '392.5px', width: '52.1px', height: '45.9px', zIndex: '4', backgroundImage: 'url(/robots-atlas.png)', backgroundRepeat: 'no-repeat', backgroundSize: '460.0px 439.1px', backgroundPosition: '-51.4px -338.9px' }} className="px-piece"></div>
<div style={{ position: 'absolute', left: '179.7px', top: '388.1px', width: '42.2px', height: '41.1px', zIndex: '4', backgroundImage: 'url(/robots-atlas.png)', backgroundRepeat: 'no-repeat', backgroundSize: '460.0px 439.1px', backgroundPosition: '-104.2px -338.9px' }} className="px-piece"></div>
<div style={{ position: 'absolute', left: '248.0px', top: '40.4px', width: '33.0px', height: '44.8px', zIndex: '2', backgroundImage: 'url(/robots-atlas.png)', backgroundRepeat: 'no-repeat', backgroundSize: '460.0px 439.1px', backgroundPosition: '-147.1px -338.9px' }} className="px-piece px-float"></div>
<div style={{ position: 'absolute', left: '248.0px', top: '85.5px', width: '30.8px', height: '45.1px', zIndex: '2', backgroundImage: 'url(/robots-atlas.png)', backgroundRepeat: 'no-repeat', backgroundSize: '460.0px 439.1px', backgroundPosition: '-180.8px -338.9px' }} className="px-piece px-float px-d2 px-f2"></div>
<div style={{ position: 'absolute', left: '23.1px', top: '220.5px', width: '30.8px', height: '39.6px', zIndex: '2', backgroundImage: 'url(/robots-atlas.png)', backgroundRepeat: 'no-repeat', backgroundSize: '460.0px 439.1px', backgroundPosition: '-212.4px -338.9px' }} className="px-piece px-float px-d2"></div>
<div style={{ position: 'absolute', left: '399.5px', top: '374.9px', width: '33.4px', height: '36.3px', zIndex: '2', backgroundImage: 'url(/robots-atlas.png)', backgroundRepeat: 'no-repeat', backgroundSize: '460.0px 439.1px', backgroundPosition: '-243.9px -338.9px' }} className="px-piece px-float px-d1"></div>
<div style={{ position: 'absolute', left: '278.4px', top: '202.5px', width: '28.6px', height: '40.7px', zIndex: '2', backgroundImage: 'url(/robots-atlas.png)', backgroundRepeat: 'no-repeat', backgroundSize: '460.0px 439.1px', backgroundPosition: '-278.1px -338.9px' }} className="px-piece px-float px-f1"></div>
<div style={{ position: 'absolute', left: '392.1px', top: '44.4px', width: '29.3px', height: '39.3px', zIndex: '2', backgroundImage: 'url(/robots-atlas.png)', backgroundRepeat: 'no-repeat', backgroundSize: '460.0px 439.1px', backgroundPosition: '-307.4px -338.9px' }} className="px-piece px-float px-d1 px-f1"></div>
<div style={{ position: 'absolute', left: '359.1px', top: '215.3px', width: '27.5px', height: '37.0px', zIndex: '2', backgroundImage: 'url(/robots-atlas.png)', backgroundRepeat: 'no-repeat', backgroundSize: '460.0px 439.1px', backgroundPosition: '-337.5px -338.9px' }} className="px-piece px-float px-d1 px-f2"></div>
<div style={{ position: 'absolute', left: '407.9px', top: '234.4px', width: '24.9px', height: '33.4px', zIndex: '2', backgroundImage: 'url(/robots-atlas.png)', backgroundRepeat: 'no-repeat', backgroundSize: '460.0px 439.1px', backgroundPosition: '-365.7px -338.9px' }} className="px-piece px-float px-d3 px-f1"></div>
<div style={{ position: 'absolute', left: '250.9px', top: '183.0px', width: '23.8px', height: '34.8px', zIndex: '2', backgroundImage: 'url(/robots-atlas.png)', backgroundRepeat: 'no-repeat', backgroundSize: '460.0px 439.1px', backgroundPosition: '-391.4px -338.9px' }} className="px-piece px-float px-d3"></div>
<div style={{ position: 'absolute', left: '114.4px', top: '377.8px', width: '26.0px', height: '21.3px', zIndex: '2', backgroundImage: 'url(/robots-atlas.png)', backgroundRepeat: 'no-repeat', backgroundSize: '460.0px 439.1px', backgroundPosition: '-416.0px -338.9px' }} className="px-piece px-float px-fast"></div>
<div style={{ position: 'absolute', left: '126.2px', top: '400.9px', width: '23.1px', height: '19.8px', zIndex: '2', backgroundImage: 'url(/robots-atlas.png)', backgroundRepeat: 'no-repeat', backgroundSize: '460.0px 439.1px', backgroundPosition: '-0.0px -413.4px' }} className="px-piece px-float px-fast px-d1"></div>
<div style={{ position: 'absolute', left: '23.1px', top: '260.8px', width: '16.9px', height: '25.7px', zIndex: '2', backgroundImage: 'url(/robots-atlas.png)', backgroundRepeat: 'no-repeat', backgroundSize: '460.0px 439.1px', backgroundPosition: '-23.8px -413.4px' }} className="px-piece px-float px-f2"></div>
<div style={{ position: 'absolute', left: '198.5px', top: '373.8px', width: '5.9px', height: '11.7px', zIndex: '2', backgroundImage: 'url(/robots-atlas.png)', backgroundRepeat: 'no-repeat', backgroundSize: '460.0px 439.1px', backgroundPosition: '-41.5px -413.4px' }} className="px-piece px-steam px-d1"></div>
<div style={{ position: 'absolute', left: '193.7px', top: '367.6px', width: '5.1px', height: '11.4px', zIndex: '2', backgroundImage: 'url(/robots-atlas.png)', backgroundRepeat: 'no-repeat', backgroundSize: '460.0px 439.1px', backgroundPosition: '-48.1px -413.4px' }} className="px-piece px-steam"></div>
<div style={{ position: 'absolute', left: '192.2px', top: '380.4px', width: '3.3px', height: '5.9px', zIndex: '2', backgroundImage: 'url(/robots-atlas.png)', backgroundRepeat: 'no-repeat', backgroundSize: '460.0px 439.1px', backgroundPosition: '-53.9px -413.4px' }} className="px-piece px-steam px-d2"></div>
<div aria-hidden="true" style={{ position: 'absolute', left: '0', top: '0', width: '460px', height: '460px', zIndex: '2', pointerEvents: 'none' }} className="px-breathe">
<svg width="460" height="460" viewBox="0 0 1254 1254" style={{ position: 'absolute', left: '0', top: '0', overflow: 'visible' }}>
<path d="M290,310 L290,462 Q290,490 318,492 Q332,494 332,520 L332,540 Q334,556 352,553 L455,506" fill="none" stroke="#FFE27A" strokeWidth="7" strokeLinecap="round" className="px-wire"></path>
<path d="M287,500 Q300,505 305,525 L308,556 Q312,566 330,564 L400,540" fill="none" stroke="#9BF6FF" strokeWidth="6" strokeLinecap="round" className="px-wire px-w2"></path>
<path d="M535,438 Q548,445 560,470" fill="none" stroke="#9BF6FF" strokeWidth="6" strokeLinecap="round" className="px-wire px-w3"></path>
<path d="M548,430 Q566,444 574,466" fill="none" stroke="#9BF6FF" strokeWidth="6" strokeLinecap="round" className="px-wire px-w4"></path>
</svg>
</div>
<span style={{ position: 'absolute', left: '129.9px', top: '156.3px', width: '2.2px', height: '4.0px', background: '#5EF0FF', zIndex: '2' }} className="px-led px-l0"></span>
<span style={{ position: 'absolute', left: '144.2px', top: '108.9px', width: '3.3px', height: '5.9px', background: '#5EF0FF', zIndex: '2' }} className="px-led px-l1"></span>
<span style={{ position: 'absolute', left: '203.6px', top: '77.8px', width: '2.0px', height: '2.0px', background: '#5EF0FF', zIndex: '2' }} className="px-led px-l2"></span>
<span style={{ position: 'absolute', left: '141.2px', top: '159.9px', width: '2.0px', height: '2.9px', background: '#5EF0FF', zIndex: '2' }} className="px-led px-l0"></span>
<span style={{ position: 'absolute', left: '154.8px', top: '172.0px', width: '2.0px', height: '2.6px', background: '#FFD84D', zIndex: '2' }} className="px-led px-l1"></span>
<span style={{ position: 'absolute', left: '159.9px', top: '151.5px', width: '2.0px', height: '2.9px', background: '#5EF0FF', zIndex: '2' }} className="px-led px-l2"></span>
<span style={{ position: 'absolute', left: '136.8px', top: '180.8px', width: '2.2px', height: '2.6px', background: '#5EF0FF', zIndex: '2' }} className="px-led px-l0"></span>
<span style={{ position: 'absolute', left: '83.3px', top: '156.3px', width: '2.9px', height: '3.7px', background: '#FFD84D', zIndex: '2' }} className="px-led px-l1"></span>
<span style={{ position: 'absolute', left: '92.8px', top: '158.1px', width: '2.0px', height: '2.0px', background: '#FFD84D', zIndex: '2' }} className="px-led px-l2"></span>
<span style={{ position: 'absolute', left: '205.8px', top: '128.0px', width: '2.0px', height: '2.0px', background: '#5EF0FF', zIndex: '2' }} className="px-led px-l0"></span>
<span style={{ position: 'absolute', left: '75.2px', top: '147.8px', width: '2.0px', height: '2.0px', background: '#5EF0FF', zIndex: '2' }} className="px-led px-l1"></span>
<span style={{ position: 'absolute', left: '154.1px', top: '173.9px', width: '2.0px', height: '2.0px', background: '#5EF0FF', zIndex: '2' }} className="px-led px-l2"></span>
<span style={{ position: 'absolute', left: '132.1px', top: '137.9px', width: '2.0px', height: '2.6px', background: '#FFD84D', zIndex: '2' }} className="px-led px-l0"></span>
<span style={{ position: 'absolute', left: '89.1px', top: '129.9px', width: '2.0px', height: '2.0px', background: '#FFD84D', zIndex: '2' }} className="px-led px-l1"></span>
<div style={{ position: 'absolute', left: '296.8px', top: '52.8px', width: '115.9px', height: '88.4px', zIndex: '5', pointerEvents: 'none' }} className="px-breathe px-d2">
<div aria-hidden="true" style={{ width: '100%', height: '100%', boxSizing: 'border-box', padding: '5px 7px', transformOrigin: '0 0', transform: 'skewY(27.5deg)', background: '#0B1024', overflow: 'hidden', fontFamily: "'JetBrains Mono', monospace", fontSize: '8px', lineHeight: '11px', color: '#D6E4FF', display: 'flex', flexDirection: 'column' }}>
<div style={{ whiteSpace: 'nowrap', overflow: 'hidden', height: '11px' }} className="tw tw0"><span style={{ color: '#6EE7B7' }}>●</span> live x402 call</div>
<div style={{ whiteSpace: 'nowrap', overflow: 'hidden', height: '11px' }} className="tw tw1"><span style={{ color: '#C4B5FD' }}>→</span> GET /s/nullsight</div>
<div style={{ whiteSpace: 'nowrap', overflow: 'hidden', height: '11px' }} className="tw tw2"><span style={{ color: '#F0ABFC' }}>← 402</span> · 0.02 USDC</div>
<div style={{ whiteSpace: 'nowrap', overflow: 'hidden', height: '11px' }} className="tw tw3"><span style={{ color: '#C4B5FD' }}>→</span> sign EIP-3009</div>
<div style={{ whiteSpace: 'nowrap', overflow: 'hidden', height: '11px' }} className="tw tw4"><span style={{ color: '#6EE7B7' }}>← 200 OK</span> · settled</div>
<div style={{ whiteSpace: 'nowrap', overflow: 'hidden', height: '11px' }} className="tw tw5"><span style={{ color: '#FDE68A' }}>split</span> 60 / 30 / 10</div>
<div style={{ width: '5px', height: '7px', background: '#6EE7B7' }} className="tw-cursor"></div>
</div>
</div>
</div>
</div>
</div>
<div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', borderTop: '1px solid #25213A' }}>
<div style={{ padding: '22px 40px', borderRight: '1px solid #25213A' }}><div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', letterSpacing: '0.14em', color: '#8C87A3' }}>SERVICES LIVE</div><div style={{ marginTop: '10px', fontSize: '26px', fontWeight: '700' }}>{v.stats.servicesLive}</div></div>
<div style={{ padding: '22px 40px', borderRight: '1px solid #25213A' }}><div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', letterSpacing: '0.14em', color: '#8C87A3' }}>PAID CALLS</div><div style={{ marginTop: '10px', fontSize: '26px', fontWeight: '700' }}>{v.stats.paidCalls}</div></div>
<div style={{ padding: '22px 40px' }}><div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', letterSpacing: '0.14em', color: '#8C87A3' }}>PAID TO PROVIDERS</div><div style={{ marginTop: '10px', fontSize: '26px', fontWeight: '700' }}>{v.stats.paidToProviders} <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', color: '#A78BFA' }}>USDC</span></div></div>
</div>
</section>
<section style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 300px', gap: '20px', marginTop: '18px' }}>
<div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
<div><h2 style={{ margin: '0', fontSize: '20px', fontWeight: '700' }}>Services on Astralaunch</h2><p style={{ margin: '6px 0 0', fontSize: '13px', color: '#8C87A3' }}>Ranked by clean revenue, last 30 days.</p></div>
</div>
<div style={{ display: 'flex', gap: '8px' }}>
{(v.filters ?? []).map((f: any, fI: number) => (<Fragment key={fI}>
<button type="button" aria-pressed={f.pressed} onClick={f.pick} style={{ height: '34px', padding: '0 14px', borderRadius: '999px', border: f.border, background: f.bg, color: f.fg, fontFamily: 'inherit', fontSize: '13px', cursor: 'pointer' }}>{f.label}</button>
</Fragment>))}
</div>
{v.cardsState}
<div className="svc-grid">
{(v.cards ?? []).map((c: any, cI: number) => (<Fragment key={cI}>
<A href={c.href} className="svc-card">
<div className="svc-head">
<span className="svc-img" style={{ background: c.tile }} aria-hidden="true">{c.initial}{c.imageUrl ? <img src={c.imageUrl} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none'; }} /> : null}</span>
<div style={{ minWidth: '0' }}>
<div className="svc-name">{c.name}</div>
<div className="svc-meta"><span className="svc-ticker">{c.ticker}</span><CopyButton text={c.asset} label="Copy token address" variant="sm" insideLink /><span className="svc-chain">Monad</span></div>
</div>
</div>
<p className="svc-desc">{c.desc}</p>
<div className="svc-divider"></div>
<dl className="svc-stats">
<div className="svc-stat"><dt>Market Cap</dt><dd className="svc-mcap">{c.mcap}</dd></div>
<div className="svc-stat"><dt>Volume 24h</dt><dd>{c.vol24}</dd></div>
</dl>
</A>
</Fragment>))}
</div>
<div style={{ display: 'flex', justifyContent: 'center', width: '1199px', marginTop: '6px' }}>
<A href={v.moreHref} style={{ height: '44px', padding: '0 22px', borderRadius: '999px', border: '1px solid #3A3456', background: 'transparent', color: '#ECEAF4', textDecoration: 'none', boxSizing: 'border-box', fontSize: '14px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '10px' }}>Check out more <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#ECEAF4" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"></path></svg></A>
</div>
</div>
<form role="search" onSubmit={v.onSearch} style={{ margin: '0' }}>
<label style={{ display: 'flex', alignItems: 'center', gap: '10px', width: '284px', height: '40px', boxSizing: 'border-box', padding: '0 14px', border: '1px solid #2A2640', borderRadius: '999px' }}>
<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8C87A3" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg>
<input type="search" value={v.query} onChange={v.onQuery} placeholder="Ticker, service or creator" aria-label="Search services (opens Discover)" style={{ border: '0', outline: 'none', background: 'transparent', color: '#ECEAF4', fontFamily: 'inherit', fontSize: '13px', width: '100%' }} />
</label>
</form>
</section>
<section style={{ marginTop: '20px', border: '1px solid #3B2A63', borderRadius: '24px', padding: '44px 40px', background: 'radial-gradient(800px 360px at 90% 100%, rgba(168,85,247,0.30), transparent 60%), linear-gradient(180deg,#221442,#170F2C)' }}>
<div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', letterSpacing: '0.18em', color: '#B9A8E8' }}>HOW IT WORKS</div>
<h2 style={{ margin: '12px 0 0', maxWidth: '560px', fontSize: '32px', lineHeight: '1.2', fontWeight: '800' }}>From API to token before the first call settles.</h2>
<div style={{ marginTop: '34px', display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: '14px' }}>
{(v.steps ?? []).map((s: any, sI: number) => (<Fragment key={sI}>
<div style={{ border: '1px solid #3B2A63', borderRadius: '16px', background: 'rgba(11,10,18,0.35)', padding: '22px', minHeight: '184px', boxSizing: 'border-box' }}>
<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><span style={{ width: '36px', height: '36px', borderRadius: '9px', background: '#2E2152', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'JetBrains Mono', monospace", fontSize: '13px', color: '#C4B5FD' }}>{s.icon}</span><span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '20px', color: '#4A3A77' }}>{s.n}</span></div>
<div style={{ marginTop: '18px', fontSize: '16px', fontWeight: '700' }}>{s.title}</div>
<p style={{ margin: '10px 0 0', fontSize: '14px', lineHeight: '1.55', color: '#B3AECB' }}>{s.body}</p>
</div>
</Fragment>))}
</div>
</section>
</main>
<SiteFooter />
</div>
  );
}

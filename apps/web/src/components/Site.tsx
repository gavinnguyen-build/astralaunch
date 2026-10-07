/** Header + footer shared by every page (markup from docs/design/Home.dc.html / Discover.dc.html). */
import { usePrivy, useWallets } from '@privy-io/react-auth';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { A } from './A.js';
import { shortAddr } from '../lib/format.js';
import { PRIVY_APP_ID } from '../env.js';

/** Privy is mounted only when VITE_PRIVY_APP_ID is set (module constant: hook order stays stable). */
const HAS_PRIVY = !!PRIVY_APP_ID;
const noPrivy = { ready: false, authenticated: false, login: () => {} };

const NAV = [
  { key: 'discover', label: 'Discover', href: '/discover' },
  { key: 'leaderboard', label: 'Leaderboard', href: '/leaderboard' },
  { key: 'creator', label: 'Creator', href: '/creator' },
  { key: 'docs', label: 'Docs', href: '/docs' },
];

/** The connected Privy wallet (or null), for signing and sending transactions. */
export function useConnectedWallet() {
  if (!HAS_PRIVY) return null;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { ready, authenticated } = usePrivy();
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { wallets } = useWallets();
  return ready && authenticated ? wallets[0] ?? null : null;
}

export const PRIVY_ENABLED = HAS_PRIVY;

/** Opens the Privy login (null when Privy is not configured). */
export function useLogin(): (() => void) | null {
  if (!HAS_PRIVY) return null;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { ready, login } = usePrivy();
  return ready ? login : null;
}

export function useWalletAddress(): string | null {
  if (!HAS_PRIVY) return null;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { ready, authenticated } = usePrivy();
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { wallets } = useWallets();
  return ready && authenticated ? wallets[0]?.address ?? null : null;
}

/** The nav item for a path: only its own route (or a sub-path) highlights it; "/" and other pages highlight nothing. */
export function navKeyFor(pathname: string): string | null {
  const p = pathname.replace(/\/+$/, '') || '/';
  return NAV.find((n) => p === n.href || p.startsWith(`${n.href}/`))?.key ?? null;
}

/** `active` is ignored (kept so the generated design views compile): the highlight follows the current route. */
export function SiteHeader(_props: { active?: string }) {
  const { pathname } = useLocation();
  const active = navKeyFor(pathname);
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [pathname]);
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { ready, authenticated, login } = HAS_PRIVY ? usePrivy() : noPrivy;
  const addr = useWalletAddress();
  return (
    <>
      <header className="al-header">
        <div className="al-header-left">
          <A href="/" style={{ display: 'flex', alignItems: 'center', gap: '10px', color: '#ECEAF4', textDecoration: 'none', fontFamily: 'Satoshi, Inter, system-ui, sans-serif', fontWeight: 700, fontSize: '18px' }}>
            <img src="/astralaunch-logo.png" alt="" width={32} height={32} style={{ width: '32px', height: '32px', display: 'block' }} />
            astralaunch
          </A>
          <nav aria-label="Primary" className="al-nav">
            {NAV.map((n) => (
              <A key={n.key} href={n.href} aria-current={n.key === active ? 'page' : undefined}>{n.label}</A>
            ))}
          </nav>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {addr ? (
            <A href="/creator" style={{ height: '40px', boxSizing: 'border-box', padding: '0 16px', borderRadius: '999px', border: '1px solid #3A3456', background: '#16132A', color: '#ECEAF4', fontSize: '14px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px', textDecoration: 'none', whiteSpace: 'nowrap' }}>
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#34D399' }}></span>{shortAddr(addr)}
            </A>
          ) : (
            <button type="button" onClick={login} disabled={!ready || authenticated} title={HAS_PRIVY ? undefined : 'Set VITE_PRIVY_APP_ID to connect a wallet'}
              style={{ height: '40px', padding: '0 20px', borderRadius: '999px', border: 0, background: '#8B5CF6', color: '#FFFFFF', fontFamily: 'inherit', fontSize: '14px', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>
              Connect
            </button>
          )}
          <button type="button" className="al-menu-btn" aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open} aria-controls="al-mobile-nav" onClick={() => setOpen((o) => !o)}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
            </svg>
          </button>
        </div>
      </header>
      <nav id="al-mobile-nav" aria-label="Primary" className="al-mobile-nav" hidden={!open}>
        <A href="/" aria-current={pathname === '/' ? 'page' : undefined}>Home</A>
        {NAV.map((n) => (
          <A key={n.key} href={n.href} aria-current={n.key === active ? 'page' : undefined}>{n.label}</A>
        ))}
        <A href="/launch" aria-current={pathname === '/launch' ? 'page' : undefined}>Launch a token</A>
      </nav>
    </>
  );
}

export function SiteFooter() {
  return (
    <footer className="al-footer">
      <span style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', color: '#8C87A3' }}>
        <img src="/astralaunch-logo.png" alt="" width={22} height={22} style={{ width: '22px', height: '22px', display: 'block', flex: 'none' }} />
        astralaunch — usage-backed tokens for x402 services.
      </span>
    </footer>
  );
}

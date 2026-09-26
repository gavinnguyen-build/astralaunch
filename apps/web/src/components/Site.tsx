/** Header + footer shared by every page (markup from docs/design/Home.dc.html / Discover.dc.html). */
import { usePrivy, useWallets } from '@privy-io/react-auth';
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
  const active = navKeyFor(useLocation().pathname);
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { ready, authenticated, login } = HAS_PRIVY ? usePrivy() : noPrivy;
  const addr = useWalletAddress();
  return (
    <header style={{ height: '64px', boxSizing: 'border-box', padding: '0 124px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid #1E1B2E' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
        <A href="/" style={{ display: 'flex', alignItems: 'center', gap: '10px', color: '#ECEAF4', textDecoration: 'none', fontWeight: 700, fontSize: '16px' }}>
          <img src="/astralaunch-logo.png" alt="" width={32} height={32} style={{ width: '32px', height: '32px', display: 'block' }} />
          astralaunch
        </A>
        <nav aria-label="Primary" style={{ display: 'flex', gap: '4px', fontSize: '14px' }}>
          {NAV.map((n) => {
            const on = n.key === active;
            return (
              <A key={n.key} href={n.href} aria-current={on ? 'page' : undefined}
                style={on
                  ? { padding: '8px 14px', borderRadius: '8px', background: '#1C1A29', color: '#ECEAF4', textDecoration: 'none' }
                  : { padding: '8px 14px', color: '#9A95B0', textDecoration: 'none' }}>
                {n.label}
              </A>
            );
          })}
        </nav>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <A href="/docs" style={{ height: '40px', boxSizing: 'border-box', padding: '0 16px', borderRadius: '999px', border: '1px solid #2A2640', background: 'transparent', color: '#ECEAF4', fontSize: '14px', display: 'flex', alignItems: 'center', gap: '8px', textDecoration: 'none' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#ECEAF4" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 9l-4 3 4 3M16 9l4 3-4 3M13.5 6l-3 12"></path></svg>For agents
        </A>
        {addr ? (
          <A href="/creator" style={{ height: '40px', boxSizing: 'border-box', padding: '0 16px', borderRadius: '999px', border: '1px solid #3A3456', background: '#16132A', color: '#ECEAF4', fontSize: '14px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px', textDecoration: 'none' }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#34D399' }}></span>{shortAddr(addr)}
          </A>
        ) : (
          <button type="button" onClick={login} disabled={!ready || authenticated} title={HAS_PRIVY ? undefined : 'Set VITE_PRIVY_APP_ID to connect a wallet'}
            style={{ height: '40px', padding: '0 20px', borderRadius: '999px', border: 0, background: '#8B5CF6', color: '#FFFFFF', fontFamily: 'inherit', fontSize: '14px', fontWeight: 600, cursor: 'pointer' }}>
            Connect
          </button>
        )}
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer style={{ marginTop: 'auto', padding: '22px 124px', borderTop: '1px solid #1E1B2E', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '16px' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', color: '#8C87A3' }}>
        <img src="/astralaunch-logo.png" alt="" width={22} height={22} style={{ width: '22px', height: '22px', display: 'block' }} />
        astralaunch — usage-backed tokens for x402 services.
      </span>
    </footer>
  );
}

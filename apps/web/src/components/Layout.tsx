import { Link, useLocation } from 'react-router-dom';
import ConnectButton from './ConnectButton.js';

const NAV = [
  { href: '/',          label: 'Explore'  },
  { href: '/launch',    label: 'Launch'   },
  { href: '/explorer',  label: 'Explorer' },
  { href: '/creator',   label: 'Creator'  },
  { href: '/docs',      label: 'Docs'     },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header style={{
        borderBottom: '1px solid var(--color-border)',
        padding: '0 1.5rem',
        height: '56px',
        display: 'flex',
        alignItems: 'center',
        gap: '2rem',
        position: 'sticky',
        top: 0,
        background: 'var(--color-bg)',
        zIndex: 100,
      }}>
        <Link to="/" style={{ display: 'flex', alignItems: 'center', gap: '8px', textDecoration: 'none' }}>
          <img src="/astralaunch-logo.png" alt="Astralaunch" style={{ height: '28px', width: '28px' }} />
          <span style={{ color: 'var(--color-accent)', fontWeight: 700, fontSize: '16px' }}>Astralaunch</span>
        </Link>

        <nav style={{ display: 'flex', gap: '1.25rem', flex: 1 }}>
          {NAV.map(n => (
            <Link
              key={n.href}
              to={n.href}
              style={{
                color:       pathname === n.href ? 'var(--color-text)' : 'var(--color-muted)',
                fontWeight:  pathname === n.href ? 600 : 400,
                fontSize:    '13px',
                textDecoration: 'none',
              }}
            >
              {n.label}
            </Link>
          ))}
        </nav>

        <ConnectButton />
      </header>

      <main style={{ flex: 1, padding: '1.5rem', maxWidth: '1100px', margin: '0 auto', width: '100%' }}>
        {children}
      </main>

      <footer style={{
        borderTop: '1px solid var(--color-border)',
        padding: '1rem 1.5rem',
        textAlign: 'center',
        color: 'var(--color-muted)',
        fontSize: '12px',
      }}>
        Tokens are not investment products. Trading fees: 2%. Built on Monad.
      </footer>
    </div>
  );
}

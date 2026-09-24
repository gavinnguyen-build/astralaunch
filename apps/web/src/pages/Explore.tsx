import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type TokenSummary } from '../lib/api.js';
import { fmtUsdc, fmtDate } from '../lib/format.js';

const TABS = [
  { id: 'clean_revenue_30d', label: 'With revenue' },
  { id: 'new',               label: 'New'          },
] as const;

export default function Explore() {
  const [tab, setTab] = useState<'clean_revenue_30d' | 'new'>('clean_revenue_30d');

  const { data, isLoading } = useQuery({
    queryKey: ['tokens', tab],
    queryFn:  () => api.tokens.list(tab),
  });

  return (
    <div>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '20px', fontWeight: 700, margin: '0 0 4px' }}>
          Explore tokens
        </h1>
        <p style={{ color: 'var(--color-muted)', margin: 0, fontSize: '13px' }}>
          Tokens backed by real API usage on Monad. Revenue funds buyback; hype alone does not.
        </p>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '1rem' }}>
        {TABS.map(t => (
          <button
            key={t.id}
            className={`btn btn-sm ${tab === t.id ? 'btn-primary' : 'btn-outline'}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
              {['Token', 'Service', 'Clean revenue 30d', 'Calls 30d', 'Launched'].map(h => (
                <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontSize: '11px',
                  fontWeight: 600, color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '.05em' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={5} style={{ padding: '2rem', textAlign: 'center', color: 'var(--color-muted)' }}>Loading…</td></tr>
            )}
            {data?.tokens.length === 0 && (
              <tr><td colSpan={5} style={{ padding: '2rem', textAlign: 'center', color: 'var(--color-muted)' }}>
                No tokens yet. <Link to="/launch">Launch the first one.</Link>
              </td></tr>
            )}
            {data?.tokens.map((t: TokenSummary) => (
              <TokenRow key={t.asset} token={t} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TokenRow({ token: t }: { token: TokenSummary }) {
  const hasRevenue = BigInt(t.metrics.cleanRevenue30d) > 0n;
  return (
    <tr style={{ borderBottom: '1px solid var(--color-border)' }}
        onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-surface)')}
        onMouseLeave={e => (e.currentTarget.style.background = '')}>
      <td style={{ padding: '12px 16px' }}>
        <Link to={`/t/${t.asset}`} style={{ display: 'flex', alignItems: 'center', gap: '10px', textDecoration: 'none' }}>
          {t.imageUrl && <img src={t.imageUrl} alt="" style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover' }} />}
          <div>
            <div style={{ fontWeight: 600, color: 'var(--color-text)' }}>{t.name}</div>
            <div style={{ fontSize: '11px', color: 'var(--color-muted)' }}>{t.symbol}</div>
          </div>
        </Link>
      </td>
      <td style={{ padding: '12px 16px' }}>
        {t.service
          ? <span style={{ fontSize: '13px' }}>{t.service.name}</span>
          : <span style={{ color: 'var(--color-muted)', fontSize: '12px' }}>—</span>}
      </td>
      <td style={{ padding: '12px 16px' }}>
        <span className={hasRevenue ? 'usage' : 'muted'} style={{ fontWeight: 600 }}>
          {fmtUsdc(t.metrics.cleanRevenue30d)}
        </span>
      </td>
      <td style={{ padding: '12px 16px', color: 'var(--color-muted)' }}>
        {t.metrics.calls30d.toLocaleString()}
      </td>
      <td style={{ padding: '12px 16px', color: 'var(--color-muted)', fontSize: '12px' }}>
        {fmtDate(t.launchedAt)}
      </td>
    </tr>
  );
}

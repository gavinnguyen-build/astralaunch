import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { fmtUsdc, fmtRelative, fmtAddr } from '../lib/format.js';

export default function Explorer() {
  const { data, isLoading } = useQuery({
    queryKey: ['explorer'],
    queryFn:  api.explorer,
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <div>
        <h1 style={{ margin: '0 0 4px', fontSize: '20px', fontWeight: 700 }}>x402 service explorer</h1>
        <p style={{ color: 'var(--color-muted)', margin: 0, fontSize: '13px' }}>
          All Astralaunch x402 API services on Monad. Any agent can pay per call.
        </p>
      </div>

      {/* Totals */}
      {data && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem' }}>
          <Stat label="Total calls 30d"   value={data.totals30d.calls.toLocaleString()} />
          <Stat label="Total revenue 30d" value={fmtUsdc(data.totals30d.revenue)} type="usage" />
          <Stat label="Unique payers 30d" value={data.totals30d.payers.toLocaleString()} type="usage" />
        </div>
      )}

      {/* Services */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
              {['Service', 'Token', 'Price', 'Calls 30d', 'Revenue 30d', 'Payers 30d'].map(h => (
                <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontSize: '11px',
                  fontWeight: 600, color: 'var(--color-muted)', textTransform: 'uppercase' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={6} style={{ padding: '2rem', textAlign: 'center', color: 'var(--color-muted)' }}>Loading…</td></tr>
            )}
            {data?.services.length === 0 && (
              <tr><td colSpan={6} style={{ padding: '2rem', textAlign: 'center', color: 'var(--color-muted)' }}>
                No services yet. <Link to="/launch">Launch one.</Link>
              </td></tr>
            )}
            {data?.services.map(svc => (
              <tr key={svc.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                <td style={{ padding: '12px 16px' }}>
                  <div style={{ fontWeight: 600 }}>{svc.name}</div>
                  <div style={{ fontSize: '11px', color: 'var(--color-muted)', fontFamily: 'monospace' }}>{svc.endpoint}</div>
                  {svc.description && <div style={{ fontSize: '11px', color: 'var(--color-muted)', marginTop: '2px' }}>{svc.description}</div>}
                </td>
                <td style={{ padding: '12px 16px' }}>
                  {svc.token
                    ? <Link to={`/t/${svc.asset}`}>{svc.token.name} ({svc.token.symbol})</Link>
                    : <span style={{ color: 'var(--color-muted)' }}>{fmtAddr(svc.asset)}</span>}
                </td>
                <td style={{ padding: '12px 16px' }}>{fmtUsdc(svc.priceUsdc)}</td>
                <td style={{ padding: '12px 16px', color: 'var(--color-muted)' }}>{svc.stats30d.calls.toLocaleString()}</td>
                <td style={{ padding: '12px 16px' }} className="usage">{fmtUsdc(svc.stats30d.revenue)}</td>
                <td style={{ padding: '12px 16px', color: 'var(--color-muted)' }}>{svc.stats30d.payers.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Recent payments */}
      {data && data.recentPayments.length > 0 && (
        <div>
          <h2 style={{ fontSize: '15px', fontWeight: 600, margin: '0 0 .75rem' }}>Recent payments</h2>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                  {['Token', 'Payer', 'Amount', 'When'].map(h => (
                    <th key={h} style={{ padding: '8px 16px', textAlign: 'left', fontSize: '11px',
                      fontWeight: 600, color: 'var(--color-muted)', textTransform: 'uppercase' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.recentPayments.map((p, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--color-border)' }}>
                    <td style={{ padding: '10px 16px' }}>
                      <Link to={`/t/${p.asset}`} style={{ fontSize: '12px', fontFamily: 'monospace' }}>{fmtAddr(p.asset)}</Link>
                    </td>
                    <td style={{ padding: '10px 16px', fontFamily: 'monospace', fontSize: '12px' }}>{fmtAddr(p.payer)}</td>
                    <td style={{ padding: '10px 16px' }} className="usage">{fmtUsdc(p.amount)}</td>
                    <td style={{ padding: '10px 16px', color: 'var(--color-muted)', fontSize: '12px' }}>
                      {fmtRelative(Math.floor(new Date(p.createdAt).getTime() / 1000))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, type }: { label: string; value: string; type?: 'usage' | 'trade' }) {
  return (
    <div className="card" style={{ padding: '1rem' }}>
      <div style={{ fontSize: '11px', color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: '4px' }}>{label}</div>
      <div style={{ fontSize: '22px', fontWeight: 700 }} className={type ?? ''}>{value}</div>
    </div>
  );
}

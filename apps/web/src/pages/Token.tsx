import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { fmtUsdc, fmtToken, fmtRelative, fmtAddr } from '../lib/format.js';

export default function Token() {
  const { asset } = useParams<{ asset: string }>();

  const { data: token, isLoading, error } = useQuery({
    queryKey: ['token', asset],
    queryFn:  () => api.tokens.get(asset!),
    enabled:  !!asset,
  });

  const { data: paymentsData } = useQuery({
    queryKey: ['payments', asset],
    queryFn:  () => api.tokens.payments(asset!),
    enabled:  !!asset,
  });

  const { data: health } = useQuery({
    queryKey: ['health', asset],
    queryFn:  () => api.tokens.health(asset!),
    enabled:  !!asset,
  });

  if (isLoading) return <div style={{ color: 'var(--color-muted)', padding: '2rem' }}>Loading…</div>;
  if (error || !token) return <div style={{ color: 'var(--color-danger)', padding: '2rem' }}>Token not found</div>;

  const rev30 = BigInt(token.metrics.cleanRevenue30d);
  const hasRevenue = rev30 > 0n;
  const now = Math.floor(Date.now() / 1000);
  const balanceLimitEnd = token.onChain.balanceLimitEnd;
  const capActive = balanceLimitEnd != null && now < balanceLimitEnd;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Hero */}
      <div className="card" style={{ display: 'flex', gap: '2rem', alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flex: 1 }}>
          {token.imageUrl && (
            <img src={token.imageUrl} alt="" style={{ width: 56, height: 56, borderRadius: '50%', objectFit: 'cover' }} />
          )}
          <div>
            <h1 style={{ margin: 0, fontSize: '22px', fontWeight: 700 }}>{token.name}</h1>
            <div style={{ color: 'var(--color-muted)', fontSize: '13px' }}>
              {token.symbol} · <span style={{ fontFamily: 'monospace' }}>{fmtAddr(token.asset)}</span>
            </div>
          </div>
        </div>

        {capActive && (
          <div style={{ padding: '8px 14px', borderRadius: '8px', background: '#2D1B4E', border: '1px solid var(--color-trade)',
            fontSize: '12px', color: 'var(--color-trade)' }}>
            Balance cap active (1% / wallet) until {fmtRelative(balanceLimitEnd)}
          </div>
        )}
      </div>

      {/* Revenue + UCR hero */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem' }}>
        <MetricCard label="Clean revenue 30d" value={fmtUsdc(token.metrics.cleanRevenue30d)} type="usage" />
        <MetricCard label="Clean revenue 7d"  value={fmtUsdc(token.metrics.cleanRevenue7d)}  type="usage" />
        <MetricCard label="Clean revenue 24h" value={fmtUsdc(token.metrics.cleanRevenue24h)} type="usage" />
        <MetricCard label="Clean payers 30d"  value={String(token.metrics.cleanPayers30d)}   type="usage" />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
        {/* Service */}
        {token.service && (
          <div className="card">
            <h2 style={{ margin: '0 0 1rem', fontSize: '15px', fontWeight: 600 }}>Service</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <Row label="Name"  value={token.service.name} />
              <Row label="Price" value={`${fmtUsdc(token.service.priceUsdc)} / call`} />
              <Row label="Endpoint" value={
                <code style={{ fontSize: '12px', background: 'var(--color-bg)', padding: '2px 6px', borderRadius: '4px' }}>
                  /s/{token.service.slug}
                </code>
              } />
              {token.service.description && (
                <p style={{ margin: 0, color: 'var(--color-muted)', fontSize: '13px' }}>{token.service.description}</p>
              )}
              {health && health.uptime != null && (
                <div style={{ marginTop: '8px' }}>
                  <span style={{ fontSize: '12px', color: health.uptime >= 0.95 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                    Uptime {(health.uptime * 100).toFixed(1)}% ({health.windowHours}h)
                  </span>
                  {health.uptime < 0.95 && (
                    <span style={{ fontSize: '11px', color: 'var(--color-danger)', marginLeft: '8px' }}>Uptime alert</span>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Escrow */}
        {token.onChain.escrow && (
          <div className="card">
            <h2 style={{ margin: '0 0 1rem', fontSize: '15px', fontWeight: 600 }}>Creator escrow</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <Row label="Accrued"        value={fmtUsdc(token.onChain.escrow.usdcAccrued)}     type="usage" />
              <Row label="Claimed"        value={fmtUsdc(token.onChain.escrow.usdcClaimed)}     />
              <Row label="Recorded rev"   value={fmtUsdc(token.onChain.escrow.recordedRevenue)} type="usage" />
              <Row label="Forfeited"      value={token.onChain.escrow.forfeited ? 'Yes' : 'No'} />
              <Row label="Forfeit date"   value={fmtRelative(token.onChain.escrow.forfeitAt)}   />
            </div>
          </div>
        )}

        {/* Buyback */}
        {token.onChain.buyback && (
          <div className="card">
            <h2 style={{ margin: '0 0 1rem', fontSize: '15px', fontWeight: 600 }}>Buyback vault</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <Row label="USDC balance"     value={fmtUsdc(token.onChain.buyback.balanceUsdc)}          />
              <Row label="From revenue"     value={fmtUsdc(token.onChain.buyback.buybackFromRevenue)}    type="usage" />
              <Row label="From trading"     value={fmtUsdc(token.onChain.buyback.buybackFromTrading)}    type="trade" />
              <Row label="Last execute"     value={fmtRelative(token.onChain.buyback.lastExecuteTime)}   />
            </div>
          </div>
        )}
      </div>

      {/* Payments feed */}
      {paymentsData && paymentsData.payments.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid var(--color-border)' }}>
            <h2 style={{ margin: 0, fontSize: '15px', fontWeight: 600 }}>Recent payments</h2>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                {['Payer', 'Amount', 'Latency', 'When'].map(h => (
                  <th key={h} style={{ padding: '8px 16px', textAlign: 'left', fontSize: '11px',
                    fontWeight: 600, color: 'var(--color-muted)', textTransform: 'uppercase' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {paymentsData.payments.map(p => (
                <tr key={p.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                  <td style={{ padding: '10px 16px', fontFamily: 'monospace', fontSize: '12px' }}>{fmtAddr(p.payer)}</td>
                  <td style={{ padding: '10px 16px' }} className="usage">{fmtUsdc(p.amountUsdc)}</td>
                  <td style={{ padding: '10px 16px', color: 'var(--color-muted)', fontSize: '12px' }}>
                    {p.latencyMs != null ? `${p.latencyMs}ms` : '—'}
                  </td>
                  <td style={{ padding: '10px 16px', color: 'var(--color-muted)', fontSize: '12px' }}>
                    {fmtRelative(Math.floor(new Date(p.createdAt).getTime() / 1000))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Economics disclosure */}
      <div style={{ fontSize: '12px', color: 'var(--color-muted)', padding: '1rem', borderRadius: '8px',
        border: '1px solid var(--color-border)', background: 'var(--color-surface)' }}>
        Trading fee: 2% of volume. Split: Doppler 5% / creator liquid 35% / creator escrow 20% / buyback 10% / platform 30%.
        Escrow unlocks 0.2 USDC per 1 USDC of service revenue. Unclaimed escrow forfeits to buyback after 365 days.
        Creator vesting: 15% supply, 30-day cliff, 365 days total.
      </div>
    </div>
  );
}

function MetricCard({ label, value, type }: { label: string; value: string; type?: 'usage' | 'trade' }) {
  return (
    <div className="card" style={{ padding: '1rem' }}>
      <div style={{ fontSize: '11px', color: 'var(--color-muted)', textTransform: 'uppercase',
        letterSpacing: '.05em', marginBottom: '4px' }}>{label}</div>
      <div style={{ fontSize: '20px', fontWeight: 700 }}
        className={type ?? ''}>
        {value}
      </div>
    </div>
  );
}

function Row({ label, value, type }: { label: string; value: React.ReactNode; type?: 'usage' | 'trade' }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
      <span style={{ color: 'var(--color-muted)', fontSize: '12px' }}>{label}</span>
      <span style={{ fontWeight: 500, fontSize: '13px' }} className={type ?? ''}>{value}</span>
    </div>
  );
}

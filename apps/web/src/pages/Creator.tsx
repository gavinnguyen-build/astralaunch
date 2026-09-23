import { usePrivy, useWallets } from '@privy-io/react-auth';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { fmtUsdc, fmtToken, fmtRelative, fmtAddr } from '../lib/format.js';

export default function Creator() {
  const { authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const address = wallets[0]?.address?.toLowerCase() ?? '';

  const { data, isLoading } = useQuery({
    queryKey: ['creator', address],
    queryFn:  () => api.creatorData(address),
    enabled:  !!address && authenticated,
  });

  if (!authenticated) {
    return (
      <div className="card" style={{ maxWidth: 400, margin: '2rem auto', textAlign: 'center' }}>
        <h2 style={{ margin: '0 0 1rem' }}>Creator dashboard</h2>
        <p style={{ color: 'var(--color-muted)', marginBottom: '1.5rem' }}>Connect to see your tokens.</p>
        <button className="btn btn-primary" onClick={login}>Connect</button>
      </div>
    );
  }

  if (isLoading) return <div style={{ color: 'var(--color-muted)', padding: '2rem' }}>Loading…</div>;
  if (!data || data.tokens.length === 0) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--color-muted)' }}>
        No tokens yet. <Link to="/launch">Launch one.</Link>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <div>
        <h1 style={{ margin: '0 0 4px', fontSize: '20px', fontWeight: 700 }}>Creator dashboard</h1>
        <div style={{ color: 'var(--color-muted)', fontSize: '12px', fontFamily: 'monospace' }}>{fmtAddr(address)}</div>
      </div>

      {data.tokens.map(t => (
        <div key={t.asset} className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
            <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
              {t.imageUrl && <img src={t.imageUrl} alt="" style={{ width: 40, height: 40, borderRadius: '50%' }} />}
              <div>
                <Link to={`/t/${t.asset}`} style={{ fontWeight: 700, fontSize: '16px', color: 'var(--color-text)' }}>{t.name}</Link>
                <div style={{ fontSize: '11px', color: 'var(--color-muted)' }}>{t.symbol} · launched {fmtRelative(Math.floor(new Date(t.launchedAt).getTime() / 1000))}</div>
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="usage" style={{ fontWeight: 700 }}>{fmtUsdc(t.metrics30d.revenue)}</div>
              <div style={{ fontSize: '11px', color: 'var(--color-muted)' }}>revenue 30d</div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            {/* Escrow */}
            {t.escrow && (
              <div style={{ padding: '12px', borderRadius: '8px', background: 'var(--color-bg)', border: '1px solid var(--color-border)' }}>
                <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '8px' }}>Trading fee escrow</div>
                <div style={{ fontSize: '13px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <span className="usage" style={{ fontWeight: 700, fontSize: '16px' }}>{fmtUsdc(t.escrow.claimableUsdc)} claimable</span>
                  <span style={{ color: 'var(--color-muted)', fontSize: '11px' }}>Accrued: {fmtUsdc(t.escrow.usdcAccrued)} · Claimed: {fmtUsdc(t.escrow.usdcClaimed)}</span>
                  <span style={{ color: 'var(--color-muted)', fontSize: '11px' }}>Revenue unlocks: {fmtUsdc(t.escrow.recordedRevenue)} recorded</span>
                  {!t.escrow.forfeited && (
                    <span style={{ color: 'var(--color-muted)', fontSize: '11px' }}>Forfeit date: {fmtRelative(t.escrow.forfeitAt)}</span>
                  )}
                  {t.escrow.forfeited && (
                    <span style={{ color: 'var(--color-danger)', fontSize: '11px' }}>Forfeited to buyback</span>
                  )}
                </div>
              </div>
            )}

            {/* Vesting */}
            {t.vesting && (
              <div style={{ padding: '12px', borderRadius: '8px', background: 'var(--color-bg)', border: '1px solid var(--color-border)' }}>
                <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '8px' }}>Token vesting (15% supply)</div>
                <div style={{ fontSize: '13px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <span style={{ fontWeight: 700, fontSize: '16px' }}>{fmtToken(t.vesting.vestedNow)} vested</span>
                  <span style={{ color: 'var(--color-muted)', fontSize: '11px' }}>Total: {fmtToken(t.vesting.totalAllocated)}</span>
                  <span style={{ color: 'var(--color-muted)', fontSize: '11px' }}>
                    Cliff: {fmtRelative(t.vesting.cliffEnd)} · End: {fmtRelative(t.vesting.vestingEnd)}
                  </span>
                  {Date.now() / 1000 < t.vesting.cliffEnd && (
                    <span style={{ color: 'var(--color-trade)', fontSize: '11px' }}>Cliff not yet reached — vesting accrues but cannot be claimed yet</span>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Service */}
          {t.service && (
            <div style={{ marginTop: '1rem', padding: '10px 14px', borderRadius: '8px', background: 'var(--color-bg)',
              border: '1px solid var(--color-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <span style={{ fontWeight: 600, fontSize: '13px' }}>{t.service.name}</span>
                <span style={{ color: 'var(--color-muted)', fontSize: '12px', marginLeft: '8px' }}>/s/{t.service.slug}</span>
              </div>
              <span style={{ fontSize: '12px' }}>{fmtUsdc(t.service.priceUsdc)} / call</span>
            </div>
          )}

          {!t.service && (
            <div style={{ marginTop: '1rem' }}>
              <Link to={`/t/${t.asset}`} className="btn btn-outline btn-sm">Attach service</Link>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

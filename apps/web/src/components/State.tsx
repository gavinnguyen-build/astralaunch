/** Loading / empty / error states in the design palette. */
import type { ReactNode } from 'react';
import { fmtUsd, fmtPrice } from '../lib/format.js';

const box = { border: '1px solid #25213A', borderRadius: '14px', background: '#13111C', padding: '28px', textAlign: 'center' as const, fontSize: '14px', color: '#A7A2BD' };

export function Loading({ rows = 3, height = 44 }: { rows?: number; height?: number }) {
  return (
    <div role="status" aria-label="Loading" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {Array.from({ length: rows }, (_, i) => <div key={i} className="al-skeleton" style={{ height: `${height}px` }} />)}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div style={box}>{children}</div>;
}

export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div role="alert" style={{ ...box, border: '1px solid #5B2330', background: '#1D1015', color: '#FCA5A5' }}>
      Could not load data{error instanceof Error ? `: ${error.message}` : ''}.
      {retry && (
        <button type="button" onClick={retry} style={{ marginLeft: '12px', height: '30px', padding: '0 12px', borderRadius: '999px', border: '1px solid #5B2330', background: 'transparent', color: '#FCA5A5', fontFamily: 'inherit', cursor: 'pointer' }}>
          Retry
        </button>
      )}
    </div>
  );
}

/** USD value, or the numeraire value with a hint when the USD price is unavailable (stale Chainlink). */
/** USD value, or the numeraire value with a note when there is no USD rate. `price`: token price formatting ($0.0₅25). */
export function UsdOr({ usd, alt, symbol, compact = false, price = false }: { usd: string | null | undefined; alt: string | null | undefined; symbol: string; compact?: boolean; price?: boolean }) {
  if (usd != null) return <>{price ? fmtPrice(usd) : fmtUsd(usd, compact)}</>;
  if (alt == null) return <>—</>;
  return (
    <span title="USD price unavailable">
      {alt} {symbol}
      <span style={{ display: 'block', fontSize: '10px', color: '#8C87A3', fontFamily: 'Inter, system-ui, sans-serif' }}>USD price unavailable</span>
    </span>
  );
}


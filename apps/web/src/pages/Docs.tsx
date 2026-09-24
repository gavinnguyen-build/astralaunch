export default function Docs() {
  return (
    <div style={{ maxWidth: '700px', display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <div>
        <h1 style={{ margin: '0 0 8px', fontSize: '22px', fontWeight: 700 }}>How Astralaunch works</h1>
        <p style={{ color: 'var(--color-muted)', margin: 0 }}>
          Usage-backed tokens on Monad — the token's buyback is funded by real API revenue, not just trading.
        </p>
      </div>

      <Section title="Two money flows">
        <p>Every Astralaunch token has two revenue streams:</p>
        <ol style={{ paddingLeft: '1.2rem', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <li><strong className="trade">Trading fees (2% of volume)</strong> — split between Doppler, the creator (part liquid, part escrowed), the buyback vault, and the platform.</li>
          <li><strong className="usage">Service revenue (x402 API payments)</strong> — agents pay per API call in USDC; split 60% provider / 30% buyback / 10% platform. Every $1 of service revenue also unlocks $0.20 of the creator's escrowed trading fees.</li>
        </ol>
      </Section>

      <Section title="Trading fee split">
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
              <Th>Beneficiary</Th><Th>Share</Th><Th>% of volume</Th>
            </tr>
          </thead>
          <tbody>
            {[
              ['Doppler protocol', '5%', '0.10%'],
              ['Creator — liquid', '35%', '0.70%'],
              ['Creator — escrow', '20%', '0.40%'],
              ['Buyback vault',    '10%', '0.20%'],
              ['Platform treasury','30%', '0.60%'],
            ].map(([b, s, v]) => (
              <tr key={b} style={{ borderBottom: '1px solid var(--color-border)' }}>
                <td style={{ padding: '8px 12px' }}>{b}</td>
                <td style={{ padding: '8px 12px', fontWeight: 600 }}>{s}</td>
                <td style={{ padding: '8px 12px', color: 'var(--color-muted)' }}>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Service revenue split">
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <tbody>
            {[
              ['Provider (API owner)', '60%'],
              ['Buyback vault',         '30%'],
              ['Platform treasury',     '10%'],
            ].map(([r, s]) => (
              <tr key={r} style={{ borderBottom: '1px solid var(--color-border)' }}>
                <td style={{ padding: '8px 12px' }}>{r}</td>
                <td style={{ padding: '8px 12px', fontWeight: 600 }}>{s}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Creator escrow">
        <p>20% of trading fees go into escrow. They unlock at a rate of <strong>0.20 USDC per 1 USDC of service revenue</strong>. Without real usage, the escrow stays locked and forfeits to the buyback vault after 365 days.</p>
        <p>This keeps creator incentives aligned: the full escrow only unlocks if the service generates real revenue.</p>
      </Section>

      <Section title="Buyback + burn">
        <p>The buyback vault accumulates USDC from both trading fees and service revenue. It buys the token from its own Uniswap v4 pool and burns the purchased tokens — reducing supply over time.</p>
        <p><strong className="usage">Usage-backed buyback</strong> = funded by service revenue (30% of each payment).<br/>
           <strong className="trade">Trading-backed buyback</strong> = funded by trading fees (10% of fee revenue).</p>
        <p>The <strong>UCR (Usage Coverage Ratio)</strong> = usage-funded buyback ÷ trading-funded buyback. UCR ≥ 1 means the token's buyback is driven more by real usage than speculation.</p>
      </Section>

      <Section title="Supply &amp; vesting">
        <p>Total supply: 1,000,000,000 tokens.<br/>
           85% (850M) into the Uniswap v4 pool at launch.<br/>
           15% (150M) to the creator — vested over 365 days with a 30-day cliff.</p>
        <p>The cliff only gates claiming; vesting accrues from day 1. At the cliff (day 30), the creator can claim ~30 days' worth at once.</p>
      </Section>

      <Section title="x402 payments">
        <p>Astralaunch services use the <a href="https://x402.org" target="_blank" rel="noreferrer">x402 protocol</a> — an HTTP-native payment standard. Agents call an API endpoint; if no payment is attached, they receive a 402 with payment requirements. They attach a signed USDC authorization and retry; the gateway verifies, forwards the request, and settles on success.</p>
        <p>The facilitator (Monad official: <code>x402-facilitator.molandak.org</code>) submits the on-chain USDC transfer. Settlement happens only after the upstream returns a successful response.</p>
      </Section>

      <Section title="Anti-snipe">
        <p>For the first ~12 minutes after launch, each wallet is limited to 1% of the total supply (10M tokens). This limits sniper bots from buying large positions at the lowest price.</p>
      </Section>

      <p style={{ fontSize: '12px', color: 'var(--color-muted)', marginTop: '1rem' }}>
        Tokens are not investment products. Buyback and revenue share to the pool are not dividends or investment returns. This product is for informational purposes.
      </p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 style={{ margin: '0 0 .75rem', fontSize: '16px', fontWeight: 600 }}>{title}</h2>
      <div style={{ color: 'var(--color-text)', fontSize: '14px', lineHeight: '1.6', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {children}
      </div>
    </section>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: '11px', fontWeight: 600, color: 'var(--color-muted)', textTransform: 'uppercase' }}>{children}</th>;
}

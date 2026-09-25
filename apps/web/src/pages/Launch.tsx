/**
 * /launch — docs/design/Launch.dc.html. Flow in lib/launch.ts (same params as mainnet-launch.ts).
 * With a LaunchHelper configured (/api/config): ONE transaction (create + register + fee) → verify →
 * ONE signature (token details + service) → listing → save. Otherwise: launch fee (unless an unused
 * receipt exists) → verify → createMulticurve → register → listing → signed metadata → signed service.
 * Every tx is simulated first; the confirmation shows the transaction and signature counts and gas.
 * The fixed initial market cap is not shown.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createPublicClient, createWalletClient, custom, defineChain, getAddress, http, isAddress, parseUnits, type Address } from 'viem';
import { LaunchView } from '../design/LaunchView.js';
import { API_BASE, RPC_URL } from '../env.js';
import { get } from '../lib/api.js';
import { executeLaunch, feeStatus, fmtMon, LaunchError, planLaunch, type ChainConfig, type Ctx, type LaunchInput, type LaunchPlan, type LaunchResult, type StepKey } from '../lib/launch.js';
import { PRIVY_ENABLED, useConnectedWallet } from '../components/Site.js';
import { AddrLink, TxLink } from '../components/Explorer.js';
import { A } from '../components/A.js';
import { shortAddr } from '../lib/format.js';

type Pair = 'usdc' | 'mon';
const STEPS: Record<LaunchPlan['mode'], [StepKey, string][]> = {
  classic: [
    ['fee', 'Pay launch fee (10 MON)'], ['verify', 'Verify fee'], ['launch', 'Create token and pool'], ['register', 'Register with Astralaunch'],
    ['listing', 'Wait for listing'], ['metadata', 'Sign token details'], ['service', 'Sign service registration'],
  ],
  helper: [
    ['launch', 'Launch: create, register and pay the fee (one transaction)'], ['verify', 'Verify fee'],
    ['sign', 'Sign token details and service (one signature)'], ['listing', 'Wait for listing'], ['details', 'Save token details and service'],
  ],
};

function useField(init = '') {
  const [value, set] = useState(init);
  return { value, set, onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(e.target.value) };
}

const card = { border: '1px solid #25213A', borderRadius: '16px', background: '#13111C', padding: '24px', width: '720px', maxHeight: '86vh', overflowY: 'auto' as const, color: '#ECEAF4' };
const row = { display: 'flex', justifyContent: 'space-between', gap: '16px', fontSize: '13px', padding: '5px 0', borderBottom: '1px solid #1E1B2E' };
const mono = { fontFamily: "'JetBrains Mono', monospace", textAlign: 'right' as const };
const btn = (primary: boolean) => ({ height: '44px', padding: '0 22px', borderRadius: '999px', border: primary ? '0' : '1px solid #3A3456', background: primary ? '#8B5CF6' : 'transparent', color: '#FFFFFF', fontFamily: 'inherit', fontSize: '14px', fontWeight: 700, cursor: 'pointer' });

export default function Launch() {
  const wallet = useConnectedWallet();
  const config = useQuery({ queryKey: ['config'], queryFn: () => get<ChainConfig>('/api/config') });
  const [pair, setPair] = useState<Pair>('usdc');
  const [service, setService] = useState<'api' | 'later'>('api');
  const f = {
    name: useField(), symbol: useField(), imageUrl: useField(), xHandle: useField(), website: useField(),
    recipient: useField(), upstream: useField(), price: useField('0.02'),
  };
  const status = useQuery({
    queryKey: ['feeStatus', wallet?.address], enabled: !!wallet && !!config.data,
    queryFn: () => feeStatus({ apiBase: API_BASE, account: wallet!.address as Address } as Ctx),
  });
  const [phase, setPhase] = useState<'form' | 'planning' | 'confirm' | 'running' | 'done' | 'error'>('form');
  const [plan, setPlan] = useState<LaunchPlan | null>(null);
  const [input, setInput] = useState<LaunchInput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<Record<string, { state: string; tx?: string; note?: string }>>({});
  const [result, setResult] = useState<LaunchResult | null>(null);

  const errors = useMemo(() => {
    const e: string[] = [];
    if (!f.name.value.trim()) e.push('Token name is required.');
    if (!/^[A-Z0-9]{2,10}$/.test(f.symbol.value.trim().toUpperCase())) e.push('Ticker: 2–10 letters or digits.');
    if (f.imageUrl.value && !/^https:\/\/\S+$/.test(f.imageUrl.value)) e.push('Image must be an https URL.');
    if (f.xHandle.value && !/^@?[A-Za-z0-9_]{1,15}$/.test(f.xHandle.value)) e.push('X account must be a handle like @name.');
    if (f.website.value && !/^https?:\/\/\S+$/.test(f.website.value)) e.push('Website must be a URL.');
    if (f.recipient.value && !isAddress(f.recipient.value)) e.push('Fee recipient must be a 0x address (ENS is not available on Monad).');
    if (service === 'api') {
      if (!/^https?:\/\/\S+$/.test(f.upstream.value)) e.push('Upstream URL is required for "My API".');
      if (!/^\d+(\.\d{1,6})?$/.test(f.price.value) || Number(f.price.value) <= 0 || Number(f.price.value) > 100) e.push('Price per call: 0.000001–100 USDC.');
    }
    return e;
  }, [f.name.value, f.symbol.value, f.imageUrl.value, f.xHandle.value, f.website.value, f.recipient.value, f.upstream.value, f.price.value, service]);

  async function clients(cfg: ChainConfig): Promise<Ctx> {
    const chain = defineChain({ id: cfg.chainId, name: 'Monad', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } });
    await wallet!.switchChain(cfg.chainId);
    const provider = await wallet!.getEthereumProvider();
    const account = getAddress(wallet!.address);
    return {
      publicClient: createPublicClient({ chain, transport: http(RPC_URL) }) as never,
      walletClient: createWalletClient({ account, chain, transport: custom(provider) }),
      account, apiBase: API_BASE, config: cfg,
    };
  }

  function buildInput(): LaunchInput {
    const symbol = f.symbol.value.trim().toUpperCase();
    const slug = symbol.toLowerCase().length >= 3 ? symbol.toLowerCase() : `${symbol.toLowerCase()}-api`;
    return {
      name: f.name.value.trim(), symbol, pairing: pair,
      feeRecipient: f.recipient.value ? getAddress(f.recipient.value) : undefined,
      imageUrl: f.imageUrl.value || undefined, xHandle: f.xHandle.value ? f.xHandle.value.replace(/^@/, '') : undefined,
      website: f.website.value || undefined,
      service: service === 'api' ? { slug, name: f.name.value.trim(), upstreamUrl: f.upstream.value, priceUsdc: parseUnits(f.price.value, 6) } : undefined,
    };
  }

  async function onLaunch() {
    if (!wallet || !config.data || errors.length) return;
    setError(null); setPhase('planning');
    try {
      const inp = buildInput();
      const ctx = await clients(config.data);
      const p = await planLaunch(ctx, inp);
      if (p.monBalance < p.estimatedMonCost) throw new LaunchError(`Not enough MON: need about ${fmtMon(p.estimatedMonCost)}, wallet has ${fmtMon(p.monBalance)}.`);
      setInput(inp); setPlan(p); setPhase('confirm');
    } catch (e) {
      setError(e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e)); setPhase('error');
    }
  }

  async function onConfirm() {
    if (!plan || !input || !config.data) return;
    setPhase('running'); setSteps({});
    try {
      const ctx = await clients(config.data);
      const r = await executeLaunch(ctx, input, plan, (step, state, info) =>
        setSteps((s) => ({ ...s, [step]: { state, tx: info?.tx, note: info?.note } })));
      setResult(r); setPhase('done'); status.refetch();
    } catch (e) {
      setError(e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e)); setPhase('error'); status.refetch();
    }
  }

  const st = status.data;
  const limitHit = !!st && config.data && st.launchesLast24h >= config.data.launchFee.maxPer24h;
  const group = <T extends string>(opts: { id: T; label: string; soon?: boolean }[], cur: T, set?: (v: T) => void) => opts.map((o) => {
    const on = o.id === cur, soon = !!o.soon;
    return { label: o.label, soon, on: on ? 'true' : 'false', ariaDis: soon ? 'true' : 'false', border: on ? '1px solid #8B5CF6' : '1px solid #25213A',
      bg: on ? '#1B1530' : '#0E0D16', fg: soon ? '#6E6987' : '#ECEAF4', cursor: soon || !set ? 'default' : 'pointer', pick: () => { if (set && !soon) set(o.id); } };
  });

  const overlay = phase === 'form' ? null : (
    <div role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, background: 'rgba(5,4,10,0.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
      <div style={card}>
        {phase === 'planning' && <p style={{ margin: 0 }}>Simulating the launch…</p>}
        {phase === 'confirm' && plan && input && <Confirm plan={plan} input={input} onCancel={() => setPhase('form')} onConfirm={onConfirm} />}
        {(phase === 'running' || phase === 'done' || (phase === 'error' && Object.keys(steps).length > 0)) && (
          <div>
            <h2 style={{ margin: '0 0 14px', fontSize: '20px' }}>{phase === 'done' ? 'Launched' : phase === 'error' ? 'Launch stopped' : 'Launching…'}</h2>
            {STEPS[plan?.mode ?? 'classic'].map(([k, label]) => {
              const s = steps[k];
              const color = !s ? '#5F5A78' : s.state === 'done' ? '#34D399' : s.state === 'error' ? '#F87171' : s.state === 'skipped' ? '#8C87A3' : '#C4B5FD';
              return (
                <div key={k} style={row}>
                  <span style={{ color }}>{s?.state === 'running' ? '● ' : s?.state === 'done' ? '✓ ' : s?.state === 'skipped' ? '– ' : s?.state === 'error' ? '✗ ' : '○ '}{label}</span>
                  <span style={{ ...mono, color: '#8C87A3' }}>{s?.tx ? <TxLink h={s.tx} /> : null}{s?.note ? ` ${s.note.length > 42 ? shortAddr(s.note) : s.note}` : ''}</span>
                </div>
              );
            })}
            {phase === 'done' && result && (
              <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 13 }}>Token <AddrLink a={result.asset} /> · router <AddrLink a={result.router} /></div>
                {result.notes.map((n) => <div key={n} style={{ fontSize: 13, color: '#FDE68A' }}>{n}</div>)}
                <div style={{ display: 'flex', gap: 10 }}>
                  <A href={`/token/${result.asset}`} style={{ ...btn(true), display: 'flex', alignItems: 'center', textDecoration: 'none' }}>Open token page</A>
                  <button type="button" style={btn(false)} onClick={() => { setPhase('form'); setResult(null); }}>Close</button>
                </div>
              </div>
            )}
          </div>
        )}
        {phase === 'error' && (
          <div style={{ marginTop: 14 }}>
            <p role="alert" style={{ margin: '0 0 14px', color: '#FCA5A5', fontSize: 14, whiteSpace: 'pre-wrap' }}>{error}</p>
            <button type="button" style={btn(false)} onClick={() => setPhase('form')}>Back to the form</button>
          </div>
        )}
      </div>
    </div>
  );

  const connected = !!wallet;
  const v = {
    f, recipientPlaceholder: wallet ? `Your wallet · ${shortAddr(wallet.address)}` : 'Your wallet',
    pairings: group<Pair | 'fx' | 'st'>([{ id: 'usdc', label: 'USDC' }, { id: 'mon', label: 'MON' }, { id: 'fx', label: 'Forex', soon: true }, { id: 'st', label: 'Stocks', soon: true }], pair, (x) => setPair(x as Pair)),
    pairHint: pair === 'mon'
      ? 'Trades settle in MON. Services are still paid in USDC, so each usage buyback swaps USDC to MON, then MON to your token.'
      : 'Services are paid in USDC, so the pool pairs with USDC and each usage buyback is a single swap.',
    vesting: group([{ id: 'v15', label: '15% vesting' }, { id: 'none', label: 'No vesting', soon: true }], 'v15'),
    services: group<'api' | 'later'>([{ id: 'api', label: 'My API' }, { id: 'later', label: 'Attach later' }], service, setService),
    hasApi: service === 'api', later: service === 'later',
    feeNote: !connected ? '' : st?.unusedReceipts.length ? 'Already paid: your unused fee will be used' : limitHit ? 'Limit reached: 3 launches per 24h' : '',
    onLaunch, onCancel: () => setPhase('form'),
    launchDisabled: !connected || !config.data || errors.length > 0 || !!limitHit || phase !== 'form',
    launchTitle: !PRIVY_ENABLED ? 'Set VITE_PRIVY_APP_ID to connect a wallet' : !connected ? 'Connect a wallet first' : limitHit ? `Limit reached. Next slot ${st?.nextSlotAt ? new Date(st.nextSlotAt * 1000).toLocaleString() : ''}` : errors[0] ?? 'Launch',
    launchLabel: !connected ? 'Connect a wallet to launch' : 'Launch',
    formErrors: connected && errors.length && (f.name.value || f.symbol.value) ? (
      <div style={{ width: '720px', margin: '-24px auto 24px', fontSize: '13px', color: '#FCA5A5' }}>{errors.map((e) => <div key={e}>{e}</div>)}</div>
    ) : null,
    overlay,
  };
  return <LaunchView v={v} />;
}

function Confirm({ plan, input, onCancel, onConfirm }: { plan: LaunchPlan; input: LaunchInput; onCancel: () => void; onConfirm: () => void }) {
  const R = ({ k, children }: { k: string; children: React.ReactNode }) => <div style={row}><span style={{ color: '#8C87A3' }}>{k}</span><span style={mono}>{children}</span></div>;
  return (
    <div>
      <h2 style={{ margin: '0 0 6px', fontSize: '20px' }}>Confirm launch</h2>
      <R k="Token">{input.name} ({input.symbol})</R>
      <R k="Pairing">{plan.numeraireSymbol}</R>
      <R k="Fee recipient"><AddrLink a={plan.creator} /></R>
      <R k="Supply">1,000,000,000 · 85% pool · 15% vested</R>
      <R k="Vesting">15% to the fee recipient · 30-day cliff · 1 year</R>
      <R k="Launch fee">{plan.feeTx.needed ? fmtMon(plan.feeTx.valueWei) : `${fmtMon(plan.feeTx.valueWei)} · already paid`}</R>
      <R k="Wallet steps">
        {plan.txCount} transaction{plan.txCount === 1 ? '' : 's'}
        {plan.mode === 'helper' ? ' (create, register and fee together)' : ''}
        {' · '}{plan.signatureCount} signature{plan.signatureCount === 1 ? '' : 's'}
        {plan.mode === 'helper' && plan.signatureCount ? ' (token details and service together)' : ''}
      </R>
      <R k="Gas (est.)">{fmtMon(plan.estimatedMonCost - (plan.feeTx.needed ? plan.feeTx.valueWei : 0n))}{plan.mode === 'classic' ? ' · register estimated' : ''}</R>
      <R k="Estimated total">{fmtMon(plan.estimatedMonCost)} (fee + gas)</R>
      <div style={{ display: 'flex', gap: 10, marginTop: 18, justifyContent: 'flex-end' }}>
        <button type="button" style={btn(false)} onClick={onCancel}>Cancel</button>
        <button type="button" style={btn(true)} onClick={onConfirm}>Confirm and launch</button>
      </div>
    </div>
  );
}

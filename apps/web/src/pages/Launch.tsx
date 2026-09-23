/**
 * Launch page (SPEC §7)
 *
 * Step 1: Creator fills token metadata + optional service details.
 * Step 2: Frontend shows fixed economics + MON gas estimate.
 * Step 3: On confirm → Doppler SDK launch (in wallet) → registry.register → POST /api/tokens.
 *
 * NOTE: The actual Doppler SDK launch call requires the full SDK integration and a connected
 * wallet's WalletClient. For the hackathon, this page provides the full UI/UX flow;
 * the actual SDK call is stubbed with a TODO comment indicating where it goes.
 */
import { useState } from 'react';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import { createWalletClient, custom, type Address } from 'viem';
import { monadChain, registryAbi } from '../lib/chain.js';
import { api } from '../lib/api.js';
import { withBuffer } from '@revpad/shared';
import { REGISTRY_ADDR } from '../env.js';

type Step = 'form' | 'review' | 'launching' | 'done';

interface FormData {
  name:        string;
  symbol:      string;
  description: string;
  imageUrl:    string;
  website:     string;
  twitter:     string;
  // Service (optional)
  attachService:  boolean;
  serviceSlug:    string;
  serviceName:    string;
  serviceDesc:    string;
  upstreamUrl:    string;
  priceUsdc:      string; // human-readable e.g. "1.00"
}

const DEFAULTS: FormData = {
  name: '', symbol: '', description: '', imageUrl: '', website: '', twitter: '',
  attachService: false, serviceSlug: '', serviceName: '', serviceDesc: '',
  upstreamUrl: '', priceUsdc: '1.00',
};

// Fixed economics (SPEC §4)
const ECONOMICS = [
  { label: 'Trading fee',           value: '2% of volume' },
  { label: 'Doppler share',         value: '0.10% of volume' },
  { label: 'Creator liquid share',  value: '0.70% of volume' },
  { label: 'Creator escrow share',  value: '0.40% of volume (unlocks with revenue)' },
  { label: 'Buyback share',         value: '0.20% of volume' },
  { label: 'Platform share',        value: '0.60% of volume' },
  { label: 'Supply',                value: '1,000,000,000 tokens' },
  { label: 'Pool allocation',       value: '85% (850M tokens)' },
  { label: 'Creator vesting',       value: '15% (150M) · 30-day cliff · 365 days' },
  { label: 'Balance cap',           value: '1% per wallet for first ~12 minutes' },
  { label: 'Gas estimate',          value: '~0.52 MON (~5M gas @ 100 gwei)' },
];

export default function Launch() {
  const { authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const [form, setForm] = useState<FormData>(DEFAULTS);
  const [step, setStep] = useState<Step>('form');
  const [result, setResult] = useState<{ asset: string; router: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const wallet = wallets[0];

  function set<K extends keyof FormData>(k: K, v: FormData[K]) {
    setForm(f => ({ ...f, [k]: v }));
  }

  async function handleLaunch() {
    if (!wallet) return;
    setStep('launching');
    setError(null);

    try {
      // ── Step 1: Doppler SDK launch ─────────────────────────────────────────
      // TODO: Import and call the Doppler SDK here.
      // The SDK call creates the Airlock, deploys DopplerERC20V1, and opens the v4 pool.
      // Required SDK config (SPEC §6.1):
      //   - initializer: V4ScheduledMulticurveInitializer
      //   - fee: 20000 (2%), tickSpacing: 200
      //   - beneficiaries: [airlockOwner 5%, creator 35%, FeeEscrow 20%, BuybackVault 10%, treasury 30%]
      //   - supply: 1e9 tokens; numTokensToSell: 850M; vested: 150M
      //   - vestingCliff: 30 days, vestingDuration: 365 days
      //   - balanceLimitEnd: startTime + 720s (target ~12 min)
      //   - numeraire: USDC; integrator: treasury
      //
      // const walletClient = createWalletClient({ account: wallet.address as Address, chain: monadChain, transport: custom(await wallet.getEthereumProvider()) });
      // const { asset } = await dopplerSdk.launch({ walletClient, ... });
      //
      // For now, throw to indicate manual integration needed:
      throw new Error('Doppler SDK launch not yet integrated. Connect your wallet and use the Doppler SDK directly. See SPEC §7 and the revpad-anvil/ scripts for the correct SDK params.');

      // ── Step 2: Register on-chain ──────────────────────────────────────────
      // After SDK returns `asset`:
      // const walletClient = ...
      // const gasEstimate = await publicClient.estimateContractGas({ address: REGISTRY_ADDR, abi: registryAbi, functionName: 'register', args: [asset, wallet.address as Address] });
      // const hash = await walletClient.writeContract({ address: REGISTRY_ADDR, abi: registryAbi, functionName: 'register', args: [asset, wallet.address as Address], gas: withBuffer(gasEstimate) });
      // await publicClient.waitForTransactionReceipt({ hash });

      // ── Step 3: Record in server DB ────────────────────────────────────────
      // const tokenRecord = await api.tokens.register({ asset, name: form.name, symbol: form.symbol, imageUrl: form.imageUrl || undefined, description: form.description || undefined, website: form.website || undefined, twitter: form.twitter || undefined });
      // if (form.attachService) { await api.services.register({ asset, creator: wallet.address, slug: form.serviceSlug, name: form.serviceName, upstreamUrl: form.upstreamUrl, priceUsdc: String(Math.round(Number(form.priceUsdc) * 1_000_000)), description: form.serviceDesc || undefined }); }
      // setResult(tokenRecord);
      // setStep('done');
    } catch (e: any) {
      setError(e.message ?? String(e));
      setStep('review');
    }
  }

  if (!authenticated) {
    return (
      <div className="card" style={{ maxWidth: 500, margin: '2rem auto', textAlign: 'center' }}>
        <h2 style={{ margin: '0 0 1rem', fontSize: '18px' }}>Connect to launch</h2>
        <p style={{ color: 'var(--color-muted)', marginBottom: '1.5rem' }}>
          Connect your wallet to launch a usage-backed token on Monad.
        </p>
        <button className="btn btn-primary" onClick={login}>Connect wallet</button>
      </div>
    );
  }

  if (step === 'done' && result) {
    return (
      <div className="card" style={{ maxWidth: 500, margin: '2rem auto', textAlign: 'center' }}>
        <div style={{ fontSize: '32px', marginBottom: '1rem' }}>✓</div>
        <h2 style={{ margin: '0 0 .5rem', fontSize: '18px' }}>Token launched</h2>
        <p style={{ color: 'var(--color-muted)', margin: '0 0 1.5rem', fontSize: '13px', fontFamily: 'monospace' }}>
          {result.asset}
        </p>
        <a href={`/t/${result.asset}`} className="btn btn-primary">View token</a>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: '1.5rem', maxWidth: '900px' }}>
      {/* Form */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div className="card">
          <h2 style={{ margin: '0 0 1rem', fontSize: '16px', fontWeight: 600 }}>Token details</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '.75rem' }}>
            <Field label="Name *" hint="e.g. My AI Service Token">
              <input value={form.name} onChange={e => set('name', e.target.value)} placeholder="My Service Token" />
            </Field>
            <Field label="Symbol *" hint="3–8 chars, e.g. MST">
              <input value={form.symbol} onChange={e => set('symbol', e.target.value.toUpperCase())} placeholder="MST" maxLength={8} />
            </Field>
            <Field label="Description">
              <textarea rows={3} value={form.description} onChange={e => set('description', e.target.value)} placeholder="What does your service do?" />
            </Field>
            <Field label="Image URL">
              <input value={form.imageUrl} onChange={e => set('imageUrl', e.target.value)} placeholder="https://…" />
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.75rem' }}>
              <Field label="Website">
                <input value={form.website} onChange={e => set('website', e.target.value)} placeholder="https://…" />
              </Field>
              <Field label="Twitter">
                <input value={form.twitter} onChange={e => set('twitter', e.target.value)} placeholder="https://x.com/…" />
              </Field>
            </div>
          </div>
        </div>

        {/* Optional service */}
        <div className="card">
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', marginBottom: form.attachService ? '1rem' : 0 }}>
            <input type="checkbox" checked={form.attachService} onChange={e => set('attachService', e.target.checked)} style={{ width: 'auto' }} />
            <span style={{ fontWeight: 600, fontSize: '14px' }}>Attach a BYO service now</span>
          </label>

          {form.attachService && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '.75rem' }}>
              <Field label="Service slug *" hint="URL-safe, e.g. my-ai-api">
                <input value={form.serviceSlug} onChange={e => set('serviceSlug', e.target.value.toLowerCase())} placeholder="my-ai-api" />
              </Field>
              <Field label="Service name *">
                <input value={form.serviceName} onChange={e => set('serviceName', e.target.value)} placeholder="My AI API" />
              </Field>
              <Field label="Upstream base URL *" hint="Your API base URL (SSRF-checked)">
                <input value={form.upstreamUrl} onChange={e => set('upstreamUrl', e.target.value)} placeholder="https://api.example.com" />
              </Field>
              <Field label="Price per call (USDC) *">
                <input type="number" min="0.000001" step="0.01" value={form.priceUsdc} onChange={e => set('priceUsdc', e.target.value)} />
              </Field>
              <Field label="Description">
                <textarea rows={2} value={form.serviceDesc} onChange={e => set('serviceDesc', e.target.value)} />
              </Field>
            </div>
          )}
        </div>

        {error && (
          <div style={{ padding: '12px', borderRadius: '8px', background: '#2D1010', border: '1px solid var(--color-danger)',
            color: 'var(--color-danger)', fontSize: '13px' }}>
            {error}
          </div>
        )}

        <button
          className="btn btn-primary"
          disabled={!form.name || !form.symbol || step === 'launching'}
          onClick={() => setStep(step === 'form' ? 'review' : 'form')}
          style={{ alignSelf: 'flex-start' }}
        >
          {step === 'form' ? 'Review launch' : 'Edit'}
        </button>

        {step === 'review' && (
          <button className="btn btn-primary" onClick={handleLaunch} style={{ alignSelf: 'flex-start' }}>
            {step === 'launching' ? 'Launching…' : 'Confirm launch (~0.52 MON)'}
          </button>
        )}
      </div>

      {/* Fixed economics panel */}
      <div className="card" style={{ alignSelf: 'start' }}>
        <h3 style={{ margin: '0 0 1rem', fontSize: '14px', fontWeight: 600 }}>Fixed economics</h3>
        <p style={{ color: 'var(--color-muted)', fontSize: '11px', margin: '0 0 1rem' }}>
          These are not configurable. This is how Revpad works.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {ECONOMICS.map(({ label, value }) => (
            <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', fontSize: '12px' }}>
              <span style={{ color: 'var(--color-muted)' }}>{label}</span>
              <span style={{ textAlign: 'right', maxWidth: '180px' }}>{value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '4px', color: 'var(--color-muted)' }}>
        {label}
        {hint && <span style={{ fontWeight: 400, marginLeft: '6px' }}>— {hint}</span>}
      </label>
      {children}
    </div>
  );
}

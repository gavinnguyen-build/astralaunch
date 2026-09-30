/**
 * "Try a sample call": one paid call to the service's sample request (GET, or POST with its JSON body) through the x402 gateway, from the
 * browser wallet (EIP-3009 signature, no gas). Used by the token page and the Home cards.
 * No path typing: the request is the creator's signed examplePath. The response body is not shown;
 * the outcome is Done + the settlement tx, or one plain sentence (the gateway never charges a failure).
 */
import { useState } from 'react';
import { formatUnits, type Address } from 'viem';
import { payAndCall, prepareCall } from '../lib/x402.js';
import { walletClients, type PrivyWallet } from '../lib/wallet.js';
import type { ChainConfig } from '../lib/launch.js';
import { API_BASE } from '../env.js';
import { Modal, btnStyle } from './Modal.js';
import { explorerUrl } from './Explorer.js';

/** Gateway origin agents call: VITE_API_BASE in production (https://api.astralaunch.xyz), else this origin. */
export const gatewayBase = () => (API_BASE || window.location.origin);
export const agentLink = (slug: string) => `${gatewayBase()}/s/${slug}/`;
export const priceLabel = (priceUsdc: string) => formatUnits(BigInt(priceUsdc), 6);

/** A service's public sample call (GET /api/tokens*, `service.sample`); null = no sample call. */
export interface ServiceSample { method: 'GET' | 'POST'; path: string; body: string | null }

/** "name: value" lines for the sample's input: query parameters, then a JSON body's top-level fields (empty = no input). */
export function exampleParams(sample: ServiceSample): [string, string][] {
  const q = sample.path.includes('?') ? sample.path.slice(sample.path.indexOf('?') + 1) : '';
  const out: [string, string][] = [...new URLSearchParams(q).entries()];
  if (sample.method === 'POST' && sample.body) {
    try {
      const j = JSON.parse(sample.body) as unknown;
      if (j && typeof j === 'object' && !Array.isArray(j)) for (const [k, v] of Object.entries(j)) out.push([k, typeof v === 'string' ? v : JSON.stringify(v)]);
      else out.push(['body', sample.body]);
    } catch { out.push(['body', sample.body]); }
  }
  return out;
}

/** The sample as one copyable request: a URL for GET, a curl command for POST. */
export function sampleRequestText(slug: string, sample: ServiceSample): string {
  const url = agentLink(slug) + sample.path.replace(/^\//, '');
  if (sample.method !== 'POST') return url;
  return `curl -X POST '${url}' -H 'Content-Type: application/json'${sample.body ? ` -d '${sample.body.replace(/'/g, `'\\''`)}'` : ''}`;
}

type State = { k: 'confirm' } | { k: 'running' } | { k: 'done'; tx: string | null } | { k: 'failed'; msg: string };

function failure(e: unknown): string {
  const raw = `${(e as { shortMessage?: string })?.shortMessage ?? ''} ${(e as Error)?.message ?? String(e)}`;
  if (/user rejected|user denied|rejected the request|cancell?ed/i.test(raw)) return 'Cancelled in your wallet. You were not charged.';
  if (/Not enough USDC/i.test(raw)) return 'Your wallet does not have enough USDC for this call.';
  if (/payTo|revenue router|does not match/i.test(raw)) return "This service's payment details do not match the chain, so nothing was paid.";
  return 'The service did not answer. You were not charged.';
}

export function SampleCall({ asset, slug, sample, priceUsdc, wallet, config, onClose, onPaid }: {
  asset: Address; slug: string; sample: ServiceSample; priceUsdc: string; wallet: PrivyWallet; config: ChainConfig;
  onClose: () => void; onPaid?: () => void;
}) {
  const [st, setSt] = useState<State>({ k: 'confirm' });
  const params = exampleParams(sample);
  const price = priceLabel(priceUsdc);

  async function run() {
    setSt({ k: 'running' });
    try {
      const c = await walletClients(wallet, config);
      const url = `${gatewayBase()}/s/${slug}${sample.path}`;
      const plan = await prepareCall(c.publicClient, c.account, url, asset, config.contracts.registry, config.tokens.usdc,
        { method: sample.method, body: sample.body });
      if ('free' in plan) {
        setSt(plan.status >= 200 && plan.status < 300 ? { k: 'done', tx: null } : { k: 'failed', msg: 'The service did not answer. You were not charged.' });
        return;
      }
      if (plan.balance < plan.amount) throw new Error('Not enough USDC');
      const out = await payAndCall(c.publicClient, c.walletClient, c.account, plan);
      if (out.status >= 200 && out.status < 300) { setSt({ k: 'done', tx: out.settleTx }); onPaid?.(); }
      else setSt({ k: 'failed', msg: 'The service did not answer. You were not charged.' });
    } catch (e) {
      setSt({ k: 'failed', msg: failure(e) });
    }
  }

  const secondary = { ...btnStyle(false), flex: 1 };
  const primary = { ...btnStyle(true), flex: 1 };
  return (
    <Modal title="Sample call" onClose={() => { if (st.k !== 'running') onClose(); }} width={400}>
      {(st.k === 'confirm' || st.k === 'running') && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ background: '#0E0D16', border: '1px solid #25213A', borderRadius: '12px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '14px' }}>
            {params.length === 0 ? <span style={{ color: '#A7A2BD' }}>No input</span>
              : params.map(([k, val], i) => (
                <div key={i} style={{ display: 'flex', gap: '8px', minWidth: 0 }}>
                  <span style={{ color: '#8C87A3' }}>{k}:</span><span style={{ color: '#ECEAF4', overflowWrap: 'anywhere' }}>{val}</span>
                </div>
              ))}
          </div>
          <p style={{ margin: 0, fontSize: '13px', color: '#A7A2BD' }}>{price} USDC · no gas · not charged if it fails</p>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button type="button" style={secondary} onClick={onClose} disabled={st.k === 'running'}>Cancel</button>
            <button type="button" style={primary} onClick={run} disabled={st.k === 'running'}>{st.k === 'running' ? 'Waiting…' : 'Sign and run'}</button>
          </div>
        </div>
      )}
      {st.k === 'done' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', padding: '6px 0 2px' }}>
          <span aria-hidden style={{ width: '52px', height: '52px', borderRadius: '50%', background: '#0F2A22', color: '#34D399', display: 'grid', placeItems: 'center' }}>
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5 9-10" /></svg>
          </span>
          <strong style={{ fontSize: '18px' }}>Done</strong>
          {st.tx && <a href={explorerUrl.tx(st.tx)} target="_blank" rel="noreferrer" style={{ color: '#C4B5FD', fontSize: '14px' }}>View transaction</a>}
          <button type="button" style={{ ...btnStyle(false), width: '100%' }} onClick={() => setSt({ k: 'confirm' })}>Try again</button>
        </div>
      )}
      {st.k === 'failed' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <p role="alert" style={{ margin: 0, fontSize: '14px', color: '#ECEAF4' }}>{st.msg}</p>
          <button type="button" style={{ ...btnStyle(false), width: '100%' }} onClick={() => setSt({ k: 'confirm' })}>Try again</button>
        </div>
      )}
    </Modal>
  );
}

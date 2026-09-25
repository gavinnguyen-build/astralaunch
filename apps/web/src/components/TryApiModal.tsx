/** "Try API": pay one call over x402 from the browser wallet (EIP-3009 signature, no gas). */
import { useState } from 'react';
import { formatUnits, type Address } from 'viem';
import { payAndCall, prepareCall, type CallPlan } from '../lib/x402.js';
import { errMsg, walletClients, type Clients, type PrivyWallet } from '../lib/wallet.js';
import type { ChainConfig } from '../lib/launch.js';
import { Actions, ErrorLine, Modal, Row, btnStyle, inputStyle } from './Modal.js';
import { AddrLink, TxLink } from './Explorer.js';
import { API_BASE } from '../env.js';

export function TryApiModal({ asset, slug, wallet, config, onClose }: {
  asset: Address; slug: string; wallet: PrivyWallet; config: ChainConfig; onClose: () => void;
}) {
  const [path, setPath] = useState('/');
  const [plan, setPlan] = useState<CallPlan | null>(null);
  const [clients, setClients] = useState<Clients | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [out, setOut] = useState<{ status: number; body: string; settleTx: string | null } | null>(null);
  const url = `${API_BASE || window.location.origin}/s/${slug}${path.startsWith('/') ? path : `/${path}`}`;

  async function prepare() {
    setErr(null); setBusy(true);
    try {
      const c = clients ?? await walletClients(wallet, config); setClients(c);
      const p = await prepareCall(c.publicClient, c.account, url, asset, config.contracts.registry, config.tokens.usdc);
      if ('free' in p) { setOut({ status: p.status, body: p.body, settleTx: null }); return; }
      if (p.balance < p.amount) throw new Error(`Not enough USDC: this call costs ${formatUnits(p.amount, 6)} USDC, balance ${formatUnits(p.balance, 6)}.`);
      setPlan(p);
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  }
  async function pay() {
    if (!plan || !clients) return;
    setErr(null); setBusy(true);
    try { setOut(await payAndCall(clients.publicClient, clients.walletClient, clients.account, plan)); setPlan(null); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  }
  let pretty = out?.body ?? '';
  try { pretty = JSON.stringify(JSON.parse(pretty), null, 2); } catch { /* not JSON */ }

  return (
    <Modal title="Try API" onClose={onClose}>
      {!plan && !out && (
        <div>
          <label style={{ fontSize: '13px', color: '#A7A2BD' }}>Request path (appended to /s/{slug})
            <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/signals?handle=monad" style={{ ...inputStyle, marginTop: 6 }} /></label>
          <p style={{ margin: '10px 0 0', fontSize: '12px', color: '#8C87A3' }}>You sign a USDC payment authorization (no gas). The gateway only settles it if the API answers successfully.</p>
          <ErrorLine msg={err} />
          <Actions><button type="button" style={btnStyle(false)} onClick={onClose}>Cancel</button><button type="button" style={btnStyle(true)} onClick={prepare} disabled={busy}>{busy ? 'Checking…' : 'Get price'}</button></Actions>
        </div>
      )}
      {plan && (
        <div>
          <Row k="Request">GET {url.replace(window.location.origin, '')}</Row>
          <Row k="Price">{formatUnits(plan.amount, 6)} USDC</Row>
          <Row k="Paid to">revenue router <AddrLink a={plan.payTo} /> (checked on-chain)</Row>
          <Row k="Network">Monad · x402 exact (EIP-3009)</Row>
          <Row k="Your USDC">{formatUnits(plan.balance, 6)}</Row>
          <Row k="Gas">none (signature only)</Row>
          <ErrorLine msg={err} />
          <Actions><button type="button" style={btnStyle(false)} onClick={() => setPlan(null)} disabled={busy}>Back</button><button type="button" style={btnStyle(true)} onClick={pay} disabled={busy}>{busy ? 'Waiting for the wallet…' : `Sign and pay ${formatUnits(plan.amount, 6)} USDC`}</button></Actions>
        </div>
      )}
      {out && (
        <div>
          <Row k="Status">{out.status}</Row>
          <Row k="Charged">{out.settleTx ? <TxLink h={out.settleTx} label="yes · settlement tx" /> : 'no'}</Row>
          <pre style={{ margin: '12px 0 0', padding: '12px', border: '1px solid #25213A', borderRadius: '10px', background: '#0E0D16', fontSize: '12px', maxHeight: '320px', overflow: 'auto', whiteSpace: 'pre-wrap' }}>{pretty.slice(0, 20_000)}</pre>
          <Actions><button type="button" style={btnStyle(false)} onClick={() => { setOut(null); }}>Another call</button><button type="button" style={btnStyle(true)} onClick={onClose}>Close</button></Actions>
        </div>
      )}
    </Modal>
  );
}

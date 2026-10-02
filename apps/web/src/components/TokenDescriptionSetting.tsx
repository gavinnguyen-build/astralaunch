/**
 * Creator page → token settings: the brief description. Saved with the same creator-signed token details update
 * as the Launch page (tokenMetadataMessage with description); "" clears it (the service description is shown instead).
 */
import { useEffect, useState } from 'react';
import { cleanTokenDescription, tokenMetadataMessage } from '@astralaunch/shared';
import type { Address } from 'viem';
import { API_BASE } from '../env.js';
import { errMsg, walletClients, type PrivyWallet } from '../lib/wallet.js';
import type { ChainConfig } from '../lib/launch.js';
import { BriefDescriptionField } from './BriefDescription.js';

const card = { border: '1px solid #25213A', borderRadius: '16px', background: '#13111C', padding: '24px', display: 'flex', flexDirection: 'column' as const, gap: '14px' };
const btn = { alignSelf: 'flex-start', height: '40px', padding: '0 18px', borderRadius: '999px', border: '1px solid #3A3456', background: 'transparent', color: '#ECEAF4', fontFamily: 'inherit', fontSize: '14px', fontWeight: 600, cursor: 'pointer' };

export function TokenDescriptionSetting({ token, wallet, config, canEdit, editTitle, onSaved }: {
  token: { asset: string; description: string | null };
  wallet: PrivyWallet | null; config: ChainConfig | undefined; canEdit: boolean; editTitle?: string;
  onSaved: () => void;
}) {
  const [text, setText] = useState(token.description ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { setText(token.description ?? ''); setMsg(null); }, [token.asset, token.description]);

  const clean = cleanTokenDescription(text);
  const changed = clean !== (token.description ?? '');

  async function onSave() {
    if (!wallet || !config || !changed) return;
    setMsg(null);
    try {
      setBusy('Sign in your wallet…');
      const c = await walletClients(wallet, config);
      // The cleaned text is what is signed, stored and shown; "" clears it.
      const m = { asset: token.asset.toLowerCase() as Address, description: clean, issuedAt: Math.floor(Date.now() / 1000) };
      const signature = await c.walletClient.signMessage({ account: c.account, message: tokenMetadataMessage(m) });
      setBusy('Saving…');
      const res = await fetch(`${API_BASE}/api/tokens`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...m, signature }) });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Not saved (${res.status})`);
      setMsg({ ok: true, text: clean ? 'Description updated.' : 'Description removed. Your service description is shown instead.' });
      onSaved();
    } catch (err) {
      const t = errMsg(err);
      setMsg({ ok: false, text: /user rejected|denied|cancell?ed/i.test(t) ? 'Cancelled in your wallet.' : t });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="tokdesc" style={card}>
      <h2 id="tokdesc" style={{ margin: 0, fontSize: '18px' }}>Brief description</h2>
      <BriefDescriptionField id="creator-brief" value={text} onChange={setText} disabled={!canEdit || !!busy} />
      <button type="button" onClick={onSave} disabled={!canEdit || !changed || !!busy} title={canEdit ? undefined : editTitle}
        style={{ ...btn, opacity: !canEdit || !changed ? 0.5 : 1, cursor: canEdit && changed && !busy ? 'pointer' : 'default' }}>
        {busy ?? 'Sign and save'}
      </button>
      <span role={msg && !msg.ok ? 'alert' : 'status'} style={{ fontSize: '13px', color: msg ? (msg.ok ? '#34D399' : '#FCA5A5') : '#8C87A3' }}>
        {msg?.text ?? 'Shown on your token page, Home and Discover. Plain text; saved with a signature from your wallet (no gas).'}
      </span>
    </section>
  );
}

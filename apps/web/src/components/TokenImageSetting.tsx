/**
 * Creator page → token settings: "Change image". Uploads the picked file, then saves it with the same
 * creator-signed token details update as the Launch page (tokenMetadataMessage with imageHash).
 */
import { useState } from 'react';
import { tokenMetadataMessage } from '@astralaunch/shared';
import type { Address } from 'viem';
import { API_BASE } from '../env.js';
import { uploadTokenImage } from '../lib/tokenImage.js';
import { errMsg, walletClients, type PrivyWallet } from '../lib/wallet.js';
import type { ChainConfig } from '../lib/launch.js';
import { TokenAvatar } from './TokenAvatar.js';

const card = { border: '1px solid #25213A', borderRadius: '16px', background: '#13111C', padding: '24px', display: 'flex', flexDirection: 'column' as const, gap: '14px' };

export function TokenImageSetting({ token, avatar, wallet, config, canEdit, editTitle, onSaved }: {
  token: { asset: string; symbol: string; imageHash: string | null; imageUrl: string | null };
  avatar: string; wallet: PrivyWallet | null; config: ChainConfig | undefined; canEdit: boolean; editTitle?: string;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !wallet || !config) return;
    setMsg(null);
    try {
      setBusy('Uploading…');
      const imageHash = await uploadTokenImage(file);
      setBusy('Sign in your wallet…');
      const c = await walletClients(wallet, config);
      const m = { asset: token.asset.toLowerCase() as Address, imageHash, issuedAt: Math.floor(Date.now() / 1000) };
      const signature = await c.walletClient.signMessage({ account: c.account, message: tokenMetadataMessage(m) });
      setBusy('Saving…');
      const res = await fetch(`${API_BASE}/api/tokens`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...m, signature }) });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Not saved (${res.status})`);
      setMsg({ ok: true, text: 'Image updated.' });
      onSaved();
    } catch (err) {
      const text = errMsg(err);
      setMsg({ ok: false, text: /user rejected|denied|cancell?ed/i.test(text) ? 'Cancelled in your wallet.' : text });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="tokimg" style={card}>
      <h2 id="tokimg" style={{ margin: 0, fontSize: '18px' }}>Token image</h2>
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
        <TokenAvatar token={token} initial={token.symbol.charAt(0)} background={avatar} size={64} radius={16} fontSize={24} />
        <label title={canEdit ? undefined : editTitle} style={{ height: '40px', boxSizing: 'border-box', padding: '0 16px', borderRadius: '999px', border: '1px solid #3A3456', color: canEdit ? '#ECEAF4' : '#5F5A78', fontSize: '14px', fontWeight: 600, display: 'flex', alignItems: 'center', cursor: canEdit && !busy ? 'pointer' : 'default' }}>
          {busy ?? 'Change image'}
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={onPick} disabled={!canEdit || !!busy}
            style={{ position: 'absolute', width: '1px', height: '1px', opacity: 0, overflow: 'hidden' }} />
        </label>
      </div>
      <span role={msg && !msg.ok ? 'alert' : 'status'} style={{ fontSize: '13px', color: msg ? (msg.ok ? '#34D399' : '#FCA5A5') : '#8C87A3' }}>
        {msg?.text ?? 'PNG, JPG or WebP, up to 2 MB. Saved with a signature from your wallet (no gas).'}
      </span>
    </section>
  );
}

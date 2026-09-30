/** "Protect your API" (Creator page): the shared secret the gateway sends, snippets that require it, probe warning. */
import { useState } from 'react';
import { protectSnippets } from '@astralaunch/shared';
import type { ServiceSettings } from '../lib/claims.js';

const card = { border: '1px solid #25213A', borderRadius: '16px', background: '#13111C', padding: '24px', display: 'flex', flexDirection: 'column' as const, gap: '14px' };
const monoBox = { margin: 0, padding: '12px 14px', borderRadius: '10px', background: '#0E0D16', border: '1px solid #2A2640', fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', lineHeight: 1.55, color: '#D9D5EA', whiteSpace: 'pre' as const, overflowX: 'auto' as const };
const small = { height: '32px', padding: '0 14px', borderRadius: '999px', border: '1px solid #3A3456', background: 'transparent', color: '#ECEAF4', fontFamily: 'inherit', fontSize: '12px', cursor: 'pointer' };

function Copy({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" style={small} onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}>
      {done ? 'Copied' : label}
    </button>
  );
}

export function ProtectApiCard({ settings, onReveal, canReveal, revealTitle, busy }: {
  settings: ServiceSettings | null;
  onReveal: () => void;
  canReveal: boolean;
  revealTitle?: string;
  busy?: boolean;
}) {
  const [tab, setTab] = useState(0);
  const unprotected = settings?.protection.status === 'unprotected';
  return (
    <section aria-labelledby="protect" style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
        <h2 id="protect" style={{ margin: 0, fontSize: '18px', fontWeight: 700 }}>Protect your API</h2>
        {settings?.protection.status ? (
          <span style={{ fontSize: '13px', color: unprotected ? '#FCA5A5' : '#34D399' }}>
            {unprotected ? 'Unprotected' : 'Protected'}{settings.protection.checkedAt ? ` · checked ${new Date(settings.protection.checkedAt).toLocaleString()}` : ''}
          </span>
        ) : null}
      </div>
      <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.55, color: '#A7A2BD' }}>
        Astralaunch sends a secret header on every call it forwards. Reject calls without it, so nobody can use your API for free by calling it directly.
      </p>
      {unprotected ? (
        <div role="alert" style={{ padding: '12px 14px', borderRadius: '10px', border: '1px solid rgba(248,113,113,0.45)', background: 'rgba(127,29,29,0.25)', fontSize: '13px', color: '#FCA5A5' }}>
          Unprotected: our probe called your API directly, without the secret, and it answered. Anyone who finds the link can skip payment. Add one of the checks below.
        </div>
      ) : null}
      {!settings ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button type="button" style={{ ...small, height: '40px' }} onClick={onReveal} disabled={!canReveal || busy} title={revealTitle}>
            {busy ? 'Waiting for your signature…' : 'Sign to show the secret'}
          </button>
          <span style={{ fontSize: '12px', color: '#8C87A3' }}>Free, no transaction. Only you can see it.</span>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <code style={{ ...monoBox, padding: '8px 12px' }}>{settings.protect.header}: {settings.protect.secret}</code>
            <Copy text={settings.protect.secret} label="Copy secret" />
          </div>
          {(() => {
            const snippets = protectSnippets(settings.protect.secret, settings.protect.header);
            const s = snippets[tab]!;
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div role="tablist" aria-label="Snippets" style={{ display: 'flex', gap: '6px' }}>
                  {snippets.map((x, i) => (
                    <button key={x.label} type="button" role="tab" aria-selected={i === tab} onClick={() => setTab(i)}
                      style={{ ...small, background: i === tab ? '#8B5CF6' : 'transparent', border: i === tab ? '0' : small.border }}>{x.label}</button>
                  ))}
                </div>
                <pre style={monoBox}>{s.code}</pre>
                <div><Copy text={s.code} label="Copy snippet" /></div>
              </div>
            );
          })()}
        </>
      )}
    </section>
  );
}

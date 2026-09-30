/**
 * "One API link" service form, shared by the Launch page and the Creator page Service card:
 * "Your API link" + "Price per call (USDC)", everything else in a collapsed "Advanced" section.
 */
import { parseApiLink, sampleBodyError } from '@astralaunch/shared';
import { parseUnits } from 'viem';
import type { ReactNode } from 'react';
import type { LinkCheckResult, ServiceInput } from '../lib/launch.js';

/** sampleMethod '' = no sample request (the link is checked with a plain GET). */
export interface ServiceLinkValue { apiLink: string; price: string; wholeDomain: boolean; keyHeader: string; keyValue: string; sampleMethod: '' | 'GET' | 'POST'; sampleBody: string }

export const emptyServiceLink = (price = '0.02'): ServiceLinkValue => ({ apiLink: '', price, wholeDomain: false, keyHeader: '', keyValue: '', sampleMethod: '', sampleBody: '' });

export const SERVICE_HELP = 'Your API must answer within one request.';

/** Form errors (empty = OK). `keyOptional`: an existing key is kept when both key fields are empty. */
export function serviceLinkErrors(v: ServiceLinkValue): string[] {
  const e: string[] = [];
  const p = parseApiLink(v.apiLink, { wholeDomain: v.wholeDomain });
  if (!p.ok) e.push(p.error);
  if (!/^\d+(\.\d{1,6})?$/.test(v.price) || Number(v.price) <= 0 || Number(v.price) > 100) e.push('Price per call: 0.000001–100 USDC.');
  if (!!v.keyHeader.trim() !== !!v.keyValue) e.push('API key: fill in both the header name and the value (or neither).');
  if (v.keyHeader.trim() && !/^[A-Za-z0-9-]{1,64}$/.test(v.keyHeader.trim())) e.push('API key header: letters, digits and "-" only (e.g. X-Api-Key).');
  if (v.sampleMethod === 'POST' && v.sampleBody.trim()) { const b = sampleBodyError(v.sampleBody.trim()); if (b) e.push(`Sample request: ${b}`); }
  return e;
}

export function toServiceLink(v: ServiceLinkValue): Pick<ServiceInput, 'apiLink' | 'priceUsdc' | 'wholeDomain' | 'apiKey' | 'sampleMethod' | 'sampleBody'> {
  return {
    apiLink: v.apiLink.trim(), priceUsdc: parseUnits(v.price, 6),
    ...(v.wholeDomain ? { wholeDomain: true } : {}),
    ...(v.keyHeader.trim() && v.keyValue ? { apiKey: { header: v.keyHeader.trim(), value: v.keyValue } } : {}),
    ...(v.sampleMethod ? { sampleMethod: v.sampleMethod } : {}),
    ...(v.sampleMethod === 'POST' && v.sampleBody.trim() ? { sampleBody: v.sampleBody.trim() } : {}),
  };
}

const input = { height: '48px', boxSizing: 'border-box' as const, padding: '0 14px', border: '1px solid #2A2640', borderRadius: '10px', background: '#0E0D16', color: '#ECEAF4', fontFamily: 'inherit', fontSize: '15px', width: '100%' };
const mono = { ...input, fontFamily: "'JetBrains Mono', monospace" };
const label = { display: 'flex', flexDirection: 'column' as const, gap: '8px', fontSize: '14px', fontWeight: 600 };
const hint = { fontSize: '13px', fontWeight: 400, color: '#8C87A3' };

/** One line describing what the link check found. */
export function checkSummary(c: LinkCheckResult): string {
  if (!c.ok) return c.error;
  if (!c.kind) return c.noSample ?? 'Your API is reachable. No sample call.';
  const what = c.kind === 'json' ? 'JSON' : c.kind === 'stream' ? 'a stream' : `a file${c.contentType ? ` (${c.contentType.split(';')[0]})` : ''}`;
  return `Your API answered ${c.status} with ${what}.`;
}

export function ServiceLinkForm({ value, onChange, check, keySet, disabled, advancedExtra }: {
  value: ServiceLinkValue;
  onChange: (v: ServiceLinkValue) => void;
  /** Not shown any more (the agent-link preview was removed); still accepted from the pages. */
  slug?: string;
  agentBase?: string;
  check?: LinkCheckResult | null;
  /** An API key is already stored (leave both key fields empty to keep it). */
  keySet?: { header: string } | null;
  disabled?: boolean;
  /** Extra fields at the end of Advanced (the Creator page's response schema). */
  advancedExtra?: ReactNode;
}) {
  const set = (patch: Partial<ServiceLinkValue>) => onChange({ ...value, ...patch });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 180px', gap: '14px' }}>
        <label style={label}>Your API link
          <input type="url" value={value.apiLink} disabled={disabled} onChange={(e) => set({ apiLink: e.target.value })}
            placeholder="https://myagent.ai/v1/ask?q=hello" spellCheck={false} style={input} />
        </label>
        <label style={label}>Price per call (USDC)
          <input type="text" inputMode="decimal" value={value.price} disabled={disabled} onChange={(e) => set({ price: e.target.value })} style={mono} />
        </label>
      </div>
      <span style={hint}>The link you already use to call your API. {SERVICE_HELP}</span>
      {check ? (
        <span role="status" style={{ fontSize: '13px', color: check.ok ? '#34D399' : '#FCA5A5' }}>{checkSummary(check)}</span>
      ) : null}
      <details style={{ border: '1px solid #25213A', borderRadius: '10px', padding: '10px 14px' }}>
        <summary style={{ cursor: 'pointer', fontSize: '14px', fontWeight: 600 }}>Advanced</summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '12px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '200px minmax(0,1fr)', gap: '14px' }}>
            <label style={label}>API key header
              <input type="text" value={value.keyHeader} disabled={disabled} onChange={(e) => set({ keyHeader: e.target.value })}
                placeholder={keySet?.header ?? 'X-Api-Key'} spellCheck={false} style={mono} />
            </label>
            <label style={label}>API key value
              <input type="password" value={value.keyValue} disabled={disabled} onChange={(e) => set({ keyValue: e.target.value })}
                placeholder={keySet ? 'Saved (leave empty to keep it)' : 'Only if your API needs one'} autoComplete="off" style={mono} />
            </label>
          </div>
          <span style={hint}>Added by Astralaunch to every call. Stored encrypted and never shown again.</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '14px' }}>
            <input type="checkbox" checked={value.wholeDomain} disabled={disabled} onChange={(e) => set({ wholeDomain: e.target.checked })} />
            Open the whole domain
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', paddingTop: '4px', borderTop: '1px solid #25213A' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '14px', fontWeight: 600, marginTop: '8px' }}>Sample request method
              <select value={value.sampleMethod} disabled={disabled} onChange={(e) => set({ sampleMethod: e.target.value as ServiceLinkValue['sampleMethod'] })} style={{ ...input, width: '140px' }}>
                <option value="">Not set</option><option value="GET">GET</option><option value="POST">POST</option>
              </select>
              {value.sampleMethod === 'GET' ? <span style={hint}>Your link is called with GET.</span> : null}
            </label>
            {value.sampleMethod === 'POST' ? (
              <label style={label}>JSON body
                <textarea value={value.sampleBody} disabled={disabled} onChange={(e) => set({ sampleBody: e.target.value })} rows={4}
                  placeholder='{"message": "hello"}' spellCheck={false}
                  style={{ ...mono, height: 'auto', padding: '10px 14px', resize: 'vertical', fontSize: '13px' }} />
              </label>
            ) : null}
            <span style={hint}>The call made to check your API and by &quot;Try a sample call&quot; on your token page. Set it if your API needs a POST body (max 16 KB).</span>
          </div>
          {advancedExtra}
        </div>
      </details>
    </div>
  );
}

/**
 * Response schema on the Creator page (D-SV4): the field in Advanced (JSON textarea, "Remove schema") and the notice
 * about responses that did not match it. Both need the signed settings: the schema and the mismatches are creator-only.
 */
import type { ServiceSettings } from '../lib/claims.js';
import { fmtTime } from '../lib/format.js';

export const RESPONSE_SCHEMA_ID = 'response-schema';
const SCHEMA_MAX = 20_000;

const mono = { boxSizing: 'border-box' as const, width: '100%', padding: '10px 14px', border: '1px solid #2A2640', borderRadius: '10px', background: '#0E0D16', color: '#ECEAF4', fontFamily: "'JetBrains Mono', monospace", fontSize: '13px', resize: 'vertical' as const };
const hint = { fontSize: '13px', color: '#8C87A3' };
const small = { height: '32px', padding: '0 14px', borderRadius: '999px', border: '1px solid #3A3456', background: 'transparent', color: '#ECEAF4', fontFamily: 'inherit', fontSize: '12px', cursor: 'pointer' };

/** Readable problem with a schema text, or null. '' (no schema) is fine. The server checks it fully on save. */
export function responseSchemaError(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (t.length > SCHEMA_MAX) return 'The schema is too long (max 20,000 characters).';
  let v: unknown;
  try { v = JSON.parse(t); } catch { return 'The schema is not valid JSON.'; }
  if (typeof v !== 'boolean' && (typeof v !== 'object' || v === null || Array.isArray(v))) return 'The schema must be a JSON object, like {"type": "object"}.';
  return null;
}

/** Compact form sent and compared ('' = no schema). */
export const compactSchema = (text: string): string => (text.trim() ? JSON.stringify(JSON.parse(text)) : '');
export const prettySchema = (stored: string | null): string => {
  if (!stored) return '';
  try { return JSON.stringify(JSON.parse(stored), null, 2); } catch { return stored; }
};

/** Open Advanced and focus the schema field (from the mismatch notice). */
export function goToResponseSchema() {
  const el = document.getElementById(RESPONSE_SCHEMA_ID) as HTMLTextAreaElement | null;
  el?.closest('details')?.setAttribute('open', '');
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el?.focus();
}

export function ResponseSchemaField({ value, onChange, settings, disabled }: {
  value: string;
  onChange: (v: string) => void;
  /** null until the creator signed "Show my settings". */
  settings: ServiceSettings | null;
  disabled?: boolean;
}) {
  const err = responseSchemaError(value);
  const locked = disabled || !settings;
  const stored = settings?.responseSchema ?? null;
  const removing = !!settings && !!stored && !value.trim();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', paddingTop: '4px', borderTop: '1px solid #25213A' }}>
      <label htmlFor={RESPONSE_SCHEMA_ID} style={{ fontSize: '14px', fontWeight: 600, marginTop: '8px' }}>Response schema</label>
      <textarea id={RESPONSE_SCHEMA_ID} value={value} disabled={locked} onChange={(e) => onChange(e.target.value)} rows={6} spellCheck={false}
        placeholder={settings ? 'No schema: responses are not checked.' : 'Show your settings to see or change the schema.'} style={mono} />
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        {settings && (stored || value.trim()) ? (
          <button type="button" style={small} disabled={locked} onClick={() => onChange('')}>Remove schema</button>
        ) : null}
        <span role={err ? 'alert' : undefined} style={{ fontSize: '13px', color: err ? '#FCA5A5' : removing ? '#FCD34D' : '#8C87A3' }}>
          {err ?? (removing ? 'The schema will be removed when you save.' : '')}
        </span>
      </div>
      <span style={hint}>Optional JSON Schema for successful responses. A response that does not match it is not charged and is not delivered. Change it when your API&apos;s answers change.</span>
    </div>
  );
}

/** "N responses did not match your schema in the last 7 days", with the latest error. Creator-only. */
export function SchemaMismatchNotice({ settings }: { settings: ServiceSettings | null }) {
  const m = settings?.schemaMismatches;
  if (!m || m.count7d === 0) return null;
  const latest = m.latest;
  return (
    <div role="status" style={{ border: '1px solid #7A5B1E', borderRadius: '12px', background: '#221B0E', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px', lineHeight: 1.5 }}>
      <strong style={{ color: '#FCD34D', fontSize: '14px' }}>
        {m.count7d.toLocaleString('en-US')} {m.count7d === 1 ? 'response' : 'responses'} did not match your schema in the last 7 days
      </strong>
      <span style={{ color: '#D9D5EA' }}>Those calls were not charged and the agents got an error instead of your answer.</span>
      {latest ? (
        <span style={{ color: '#A7A2BD', wordBreak: 'break-word' }}>
          Latest, {fmtTime(latest.at)}{latest.path ? <> on <code>{latest.path}</code></> : null}: {latest.detail ?? latest.code}
        </span>
      ) : null}
      <span>
        <button type="button" onClick={goToResponseSchema} style={{ ...small, height: 'auto', padding: 0, border: 0, color: '#C4B5FD', textDecoration: 'underline' }}>
          Update or remove the schema
        </button>
      </span>
    </div>
  );
}

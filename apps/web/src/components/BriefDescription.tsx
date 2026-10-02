/**
 * "Brief description" of a token (Launch page, Creator settings): plain text, at most 200 characters, live counter.
 * Typing past the limit is blocked; the text is cleaned (cleanTokenDescription) before it is signed.
 */
import { TOKEN_DESCRIPTION_MAX } from '@astralaunch/shared';

const area = {
  boxSizing: 'border-box' as const, width: '100%', minHeight: '76px', padding: '12px 14px', border: '1px solid #2A2640', borderRadius: '10px',
  background: '#0E0D16', color: '#ECEAF4', fontFamily: 'inherit', fontSize: '15px', lineHeight: 1.5, resize: 'vertical' as const,
};

export function BriefDescriptionField({ value, onChange, disabled, id = 'brief-description' }: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  id?: string;
}) {
  const n = value.length;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <label htmlFor={id} style={{ fontSize: '14px', fontWeight: 600 }}>Brief description</label>
      <textarea id={id} value={value} disabled={disabled} maxLength={TOKEN_DESCRIPTION_MAX} rows={2}
        onChange={(e) => onChange(e.target.value.slice(0, TOKEN_DESCRIPTION_MAX))}
        placeholder={`What does your agent do? (max ${TOKEN_DESCRIPTION_MAX} characters)`} aria-describedby={`${id}-count`} style={area} />
      <span id={`${id}-count`} aria-live="polite" style={{ alignSelf: 'flex-end', fontSize: '12px', color: n >= TOKEN_DESCRIPTION_MAX ? '#FCD34D' : '#8C87A3', fontVariantNumeric: 'tabular-nums' }}>
        {n}/{TOKEN_DESCRIPTION_MAX}
      </span>
    </div>
  );
}

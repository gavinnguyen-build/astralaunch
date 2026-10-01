/**
 * The one copy button used across the app. Click → copy `text`; for 1.5 s the button turns green with a
 * check and "Copied" (or red "Copy failed" if the clipboard write fails), then returns to normal.
 * The result is also announced through an aria-live region. Press animation: CopyButton.css.
 */
import { useEffect, useRef, useState } from 'react';
import './CopyButton.css';

type State = 'idle' | 'copied' | 'failed';
const FEEDBACK_MS = 1500;

const CopyIcon = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a1 1 0 0 1 1-1h10" />
  </svg>
);
const CheckIcon = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m5 12 5 5 9-10" />
  </svg>
);

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * `variant`: 'icon' (square icon button, the label is the accessible name), 'sm' (smaller icon button, for
 * inline addresses) or 'pill' (text button showing `label`).
 */
export function CopyButton({ text, label = 'Copy', variant = 'icon' }: { text: string; label?: string; variant?: 'icon' | 'sm' | 'pill' }) {
  const [state, setState] = useState<State>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  async function onClick() {
    const ok = await writeClipboard(text);
    setState(ok ? 'copied' : 'failed');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), FEEDBACK_MS);
  }

  const iconSize = variant === 'sm' ? 13 : 15;
  return (
    <span style={{ display: 'inline-flex', position: 'relative' }}>
      <button type="button" className={`copy-btn copy-btn--${variant}`} data-state={state} onClick={onClick}
        aria-label={variant === 'pill' ? undefined : label} title={state === 'idle' ? label : undefined}>
        {state === 'copied' ? <><CheckIcon size={iconSize} />Copied</>
          : state === 'failed' ? <>Copy failed</>
          : variant === 'pill' ? label : <CopyIcon size={iconSize} />}
      </button>
      <span className="copy-sr" role="status" aria-live="polite">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : ''}</span>
    </span>
  );
}

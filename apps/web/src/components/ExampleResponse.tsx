/**
 * Token page "Example response": starts at the top, wraps long lines and URLs (no horizontal clipping), and is capped
 * at ~320 px with a bottom fade and a "Show full response" toggle when the content is taller.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

const CAP_PX = 320;

export function ExampleResponse({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [open, setOpen] = useState(false);
  const [tall, setTall] = useState(false);

  // New content: collapse, back to the top, and measure whether it needs the toggle.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setOpen(false);
    el.scrollTop = 0;
    setTall(el.scrollHeight > CAP_PX + 4);
  }, [children]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 }}>
      <div style={{ position: 'relative' }}>
        <pre ref={ref} style={{
          margin: 0, padding: '14px', borderRadius: '10px', background: '#0E0D16', border: '1px solid #25213A',
          fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', lineHeight: 1.6, color: '#C9C5DA',
          whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word',
          maxHeight: open ? 'none' : `${CAP_PX}px`, overflow: 'hidden',
        }}>{children}</pre>
        {tall && !open ? (
          <div aria-hidden="true" style={{
            position: 'absolute', left: '1px', right: '1px', bottom: '1px', height: '72px', borderRadius: '0 0 10px 10px',
            background: 'linear-gradient(to bottom, rgba(14,13,22,0), #0E0D16)', pointerEvents: 'none',
          }} />
        ) : null}
      </div>
      {tall ? (
        <button type="button" aria-expanded={open} onClick={() => { setOpen((o) => !o); if (open) ref.current?.scrollIntoView({ block: 'nearest' }); }}
          style={{ alignSelf: 'flex-start', padding: 0, border: 0, background: 'transparent', color: '#C4B5FD', fontFamily: 'inherit', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>
          {open ? 'Show less' : 'Show full response'}
        </button>
      ) : null}
    </div>
  );
}

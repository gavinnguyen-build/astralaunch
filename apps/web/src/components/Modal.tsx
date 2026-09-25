/** Confirmation / progress dialog in the design palette. */
import type { ReactNode } from 'react';

export const rowStyle = { display: 'flex', justifyContent: 'space-between', gap: '16px', fontSize: '13px', padding: '6px 0', borderBottom: '1px solid #1E1B2E' };
export const btnStyle = (primary: boolean) => ({ height: '42px', padding: '0 20px', borderRadius: '999px', border: primary ? '0' : '1px solid #3A3456', background: primary ? '#8B5CF6' : 'transparent', color: '#FFFFFF', fontFamily: 'inherit', fontSize: '14px', fontWeight: 700, cursor: 'pointer' });
export const inputStyle = { width: '100%', height: '42px', boxSizing: 'border-box' as const, padding: '0 12px', border: '1px solid #2A2640', borderRadius: '10px', background: '#0E0D16', color: '#ECEAF4', fontFamily: 'inherit', fontSize: '14px' };

export function Row({ k, children }: { k: string; children: ReactNode }) {
  return <div style={rowStyle}><span style={{ color: '#8C87A3' }}>{k}</span><span style={{ fontFamily: "'JetBrains Mono', monospace", textAlign: 'right' }}>{children}</span></div>;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div role="dialog" aria-modal="true" aria-label={title} onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(5,4,10,0.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ border: '1px solid #25213A', borderRadius: '16px', background: '#13111C', padding: '24px', width: '560px', maxHeight: '86vh', overflowY: 'auto', color: '#ECEAF4', fontFamily: 'Inter, system-ui, sans-serif' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
          <h2 style={{ margin: 0, fontSize: '19px' }}>{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose} style={{ border: 0, background: 'transparent', color: '#8C87A3', fontSize: '20px', cursor: 'pointer' }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Actions({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', gap: '10px', marginTop: '18px', justifyContent: 'flex-end' }}>{children}</div>;
}

export function ErrorLine({ msg }: { msg: string | null }) {
  return msg ? <p role="alert" style={{ margin: '12px 0 0', color: '#FCA5A5', fontSize: '13px', whiteSpace: 'pre-wrap' }}>{msg}</p> : null;
}

/**
 * Monad explorer links (Monadscan by default). Framework-free so it can be unit tested.
 * VITE_EXPLORER_URL is trimmed; an empty, relative or non-http(s) value falls back to Monadscan, so every link
 * is absolute (an empty build arg once produced https://astralaunch.xyz/tx/<hash>).
 */
import { MONAD_EXPLORER_URL } from '@astralaunch/shared';

/** Absolute explorer base without a trailing slash. */
export function explorerBase(raw: string | undefined | null): string {
  const v = (raw ?? '').trim();
  if (v) {
    try {
      const u = new URL(v);
      if ((u.protocol === 'https:' || u.protocol === 'http:') && u.host) return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
    } catch { /* not an absolute URL */ }
  }
  return MONAD_EXPLORER_URL.replace(/\/+$/, '');
}

export function explorerLinks(base: string) {
  return {
    address: (a: string) => `${base}/address/${a}`,
    tx: (h: string) => `${base}/tx/${h}`,
    token: (a: string) => `${base}/token/${a}`,
  };
}

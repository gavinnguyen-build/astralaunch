/**
 * Small in-memory fixed-window rate limiter (per process), keyed by client IP.
 * The server runs behind Cloudflare Tunnel, so the client IP comes from CF-Connecting-IP; without it,
 * the first X-Forwarded-For entry, then X-Real-IP, then the socket address.
 */
import type { Context } from 'hono';

export function clientIp(c: Context): string {
  const h = (n: string) => c.req.header(n)?.trim();
  const xff = h('x-forwarded-for')?.split(',')[0]?.trim();
  const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
  return h('cf-connecting-ip') || xff || h('x-real-ip') || socket || 'unknown';
}

/** Returns allow(key): true while the key has used fewer than `max` calls in the current window. */
export function fixedWindowLimiter({ max, windowMs, now = () => Date.now() }: { max: number; windowMs: number; now?: () => number }) {
  const hits = new Map<string, { start: number; n: number }>();
  return (key: string): boolean => {
    const t = now();
    const cur = hits.get(key);
    if (!cur || t - cur.start >= windowMs) {
      hits.set(key, { start: t, n: 1 });
      if (hits.size > 50_000) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
      return true;
    }
    if (cur.n >= max) return false;
    cur.n += 1;
    return true;
  };
}

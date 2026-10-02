/**
 * Client IP for rate limiting, and a small in-memory fixed-window limiter.
 *
 * The IP comes ONLY from what our own reverse proxy added: production runs behind Coolify's Traefik
 * (TLS terminated there, no Cloudflare), which appends the address it saw to X-Forwarded-For. With
 * TRUSTED_PROXY_HOPS = n trusted proxies, the client is the n-th entry from the RIGHT; anything to its
 * left was sent by the client and is ignored. Without a proxy (n = 0) it is the socket address.
 * TRUSTED_PROXY_CIDRS (optional, comma-separated) additionally requires the direct peer to be inside one of
 * those ranges before X-Forwarded-For is used at all. CF-Connecting-IP, X-Real-IP and True-Client-IP are
 * client-controllable here and are never read.
 */
import { BlockList, isIP } from 'node:net';
import type { Context } from 'hono';

export interface TrustedProxyConfig { hops: number; cidrs: BlockList | null }

export function parseTrustedProxy(env: { TRUSTED_PROXY_HOPS?: string; TRUSTED_PROXY_CIDRS?: string } = process.env): TrustedProxyConfig {
  const raw = (env.TRUSTED_PROXY_HOPS ?? '').trim();
  const hops = raw === '' ? 0 : Number(raw);
  if (!Number.isInteger(hops) || hops < 0 || hops > 5) throw new Error(`TRUSTED_PROXY_HOPS must be an integer 0-5, got "${raw}"`);
  const list = (env.TRUSTED_PROXY_CIDRS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return { hops, cidrs: null };
  const cidrs = new BlockList();
  for (const c of list) {
    const [addr, bits] = c.split('/');
    const fam = isIP(addr ?? '');
    const prefix = bits === undefined ? (fam === 6 ? 128 : 32) : Number(bits);
    if (!fam || !Number.isInteger(prefix) || prefix < 0 || prefix > (fam === 6 ? 128 : 32)) throw new Error(`TRUSTED_PROXY_CIDRS: "${c}" is not a CIDR`);
    cidrs.addSubnet(addr!, prefix, fam === 6 ? 'ipv6' : 'ipv4');
  }
  return { hops, cidrs };
}

/** "::ffff:1.2.3.4" → "1.2.3.4"; anything that is not an IP → null. */
function normalizeIp(s: string | undefined | null): string | null {
  const v = (s ?? '').trim().replace(/^\[|\]$/g, '');
  const ip = v.toLowerCase().startsWith('::ffff:') && isIP(v.slice(7)) === 4 ? v.slice(7) : v;
  return isIP(ip) ? ip : null;
}

/** Pure resolution (tested): socket address + X-Forwarded-For header under the trusted-proxy config. */
export function resolveClientIp(socket: string | undefined, xff: string | undefined, cfg: TrustedProxyConfig): string {
  const peer = normalizeIp(socket);
  if (cfg.hops === 0) return peer ?? 'unknown';
  if (cfg.cidrs && !(peer && cfg.cidrs.check(peer, isIP(peer) === 6 ? 'ipv6' : 'ipv4'))) return peer ?? 'unknown';
  const entries = (xff ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const chosen = entries.length >= cfg.hops ? normalizeIp(entries[entries.length - cfg.hops]) : null;
  return chosen ?? peer ?? 'unknown';
}

const TRUSTED = parseTrustedProxy();

export function clientIp(c: Context, cfg: TrustedProxyConfig = TRUSTED): string {
  const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
  return resolveClientIp(socket, c.req.header('x-forwarded-for'), cfg);
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

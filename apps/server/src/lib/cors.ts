/**
 * CORS for the browser app (e.g. https://astralaunch.xyz calling https://api.astralaunch.xyz).
 * Only origins listed in CORS_ORIGINS are allowed; an empty list allows no cross-origin calls.
 * Applied to /api/* and the /s/* x402 gateway. A preflight is answered here and never reaches
 * the gateway, so it is not answered with a 402.
 */
import { cors } from 'hono/cors';
import { PAYMENT_HEADERS, PAYMENT_REQUIRED_HEADERS, PAYMENT_RESPONSE_HEADERS } from './x402Headers.js';

/** "https://a.xyz, https://www.a.xyz" → exact origins. Throws on a wildcard, a path, or a non-http(s) URL. */
export function parseCorsOrigins(raw: string | undefined): string[] {
  const list = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.map((o) => {
    let u: URL;
    try { u = new URL(o); } catch { throw new Error(`CORS_ORIGINS: "${o}" is not a URL`); }
    if (o.includes('*') || !/^https?:$/.test(u.protocol) || u.origin !== o.replace(/\/$/, '')) {
      throw new Error(`CORS_ORIGINS: "${o}" must be a bare origin like https://astralaunch.xyz (no wildcard, path or query)`);
    }
    return u.origin;
  });
}

export function corsFor(origins: readonly string[]) {
  const allowed = new Set(origins);
  return cors({
    origin: (origin) => (allowed.has(origin) ? origin : null),
    allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Accept', ...PAYMENT_HEADERS],
    exposeHeaders: [...PAYMENT_RESPONSE_HEADERS, ...PAYMENT_REQUIRED_HEADERS],
    credentials: false,
    maxAge: 600,
  });
}

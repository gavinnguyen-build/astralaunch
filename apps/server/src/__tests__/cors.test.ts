/**
 * CORS (lib/cors.ts): only CORS_ORIGINS may call /api/* and the /s/* gateway from a browser.
 * Preflights are answered before the gateway (never a 402), the x402 request headers are allowed,
 * and the payment response headers are exposed so the browser SDK client can read them.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Hono } from 'hono';
import { createTestDb, type TestDb } from './helpers/pgliteDb.js';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../db/client.js', () => ({ get db() { return h.db; } }));
vi.mock('../env.js', () => ({
  FACILITATOR_URL: 'http://facilitator.invalid', USDC_ADDR: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
  CHAIN_ID: 143, PAYMENT_TIMEOUT_S: 60,
}));

const { services } = await import('../db/schema.js');
const { corsFor, parseCorsOrigins } = await import('../lib/cors.js');
const gateway = (await import('../routes/gateway.js')).default;

const ALLOWED = 'https://astralaunch.xyz';
const EVIL = 'https://evil.example';
const app = new Hono();
const mw = corsFor(parseCorsOrigins('https://astralaunch.xyz,https://www.astralaunch.xyz'));
app.use('/api/*', mw);
app.use('/s/*', mw);
app.get('/api/stats', (c) => c.json({ ok: true }));
app.route('/s', gateway);

const preflight = (path: string, origin: string, method = 'GET', headers = 'content-type') =>
  app.request(path, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': headers } });

describe('CORS', () => {
  let db: TestDb; let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    h.db = db;
    await db.insert(services).values({
      slug: 'svc', name: 'svc', asset: '0x' + 'a'.repeat(40), router: '0x' + '5'.repeat(40), creator: '0x' + '2'.repeat(40),
      upstreamUrl: 'https://upstream.example', priceUsdc: '10000', upstreamSecret: 's',
    });
  });
  afterAll(async () => { await close(); });

  it('preflight /api from an allowed origin', async () => {
    const res = await preflight('/api/services', ALLOWED, 'POST');
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('PATCH');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Content-Type');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    expect(res.headers.get('Vary')).toContain('Origin');
  });

  it('preflight /s gateway with x402 headers from an allowed origin is not answered with a 402', async () => {
    const res = await preflight('/s/svc/sight/signals', 'https://www.astralaunch.xyz', 'GET', 'payment-signature');
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://www.astralaunch.xyz');
    const allow = res.headers.get('Access-Control-Allow-Headers')!;
    for (const x of ['PAYMENT-SIGNATURE', 'X-PAYMENT']) expect(allow).toContain(x);
  });

  it('preflight from a disallowed origin gets no Access-Control-Allow-Origin (browser blocks)', async () => {
    for (const path of ['/api/services', '/s/svc/json']) {
      const res = await preflight(path, EVIL, 'POST', 'payment-signature');
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
      expect(res.status).not.toBe(402);
    }
  });

  it('actual requests: allowed origin gets ACAO + exposed payment headers, disallowed gets none', async () => {
    const ok = await app.request('/s/svc/json', { headers: { Origin: ALLOWED } });
    expect(ok.status).toBe(402);
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED);
    const exposed = ok.headers.get('Access-Control-Expose-Headers')!;
    for (const x of ['PAYMENT-RESPONSE', 'X-PAYMENT-RESPONSE', 'PAYMENT-REQUIRED']) expect(exposed).toContain(x);
    const api = await app.request('/api/stats', { headers: { Origin: ALLOWED } });
    expect(api.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED);

    const bad = await app.request('/api/stats', { headers: { Origin: EVIL } });
    expect(bad.status).toBe(200);   // server-side calls still work; only the browser is blocked
    expect(bad.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('parseCorsOrigins accepts bare origins and rejects wildcards, paths and junk', () => {
    expect(parseCorsOrigins(' https://astralaunch.xyz , https://www.astralaunch.xyz/ ,')).toEqual(['https://astralaunch.xyz', 'https://www.astralaunch.xyz']);
    expect(parseCorsOrigins(undefined)).toEqual([]);
    expect(parseCorsOrigins('http://localhost:3000')).toEqual(['http://localhost:3000']);
    for (const bad of ['*', 'https://*.astralaunch.xyz', 'https://astralaunch.xyz/app', 'astralaunch.xyz', 'ftp://astralaunch.xyz']) {
      expect(() => parseCorsOrigins(bad)).toThrow(/CORS_ORIGINS/);
    }
  });
});

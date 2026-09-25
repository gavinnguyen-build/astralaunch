/**
 * The gateway speaks standard x402 v2 headers (as the SDK's x402HTTPClient does)
 * and still accepts the legacy X-PAYMENT names (D-GW1). Settle only after upstream 2xx.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { createTestDb, type TestDb } from './helpers/pgliteDb.js';

const h = vi.hoisted(() => ({
  db: null as unknown,
  verify: vi.fn(async () => ({ isValid: true })),
  settle: vi.fn(async () => ({ success: true, transaction: '0x' + 'e'.repeat(64), network: 'eip155:143', payer: '0x' + '1'.repeat(40) })),
}));
vi.mock('../db/client.js', () => ({ get db() { return h.db; } }));
vi.mock('../env.js', () => ({
  FACILITATOR_URL: 'http://facilitator.invalid', USDC_ADDR: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
  CHAIN_ID: 143, PAYMENT_TIMEOUT_S: 60,
}));
vi.mock('@x402/core/http', async (orig) => ({
  ...(await orig<typeof import('@x402/core/http')>()),
  HTTPFacilitatorClient: class { verify = h.verify; settle = h.settle; },
}));

const { services } = await import('../db/schema.js');
const { x402HTTPClient, x402Client } = await import('@x402/core/client');
const { encodePaymentSignatureHeader } = await import('@x402/core/http');
const gateway = (await import('../routes/gateway.js')).default;

const ROUTER = '0x' + '5'.repeat(40);
const app = new Hono();
app.route('/s', gateway);
const sdk = new x402HTTPClient(new x402Client());

describe('gateway x402 headers', () => {
  let db: TestDb; let close: () => Promise<void>;
  const upstream = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    h.db = db;
    await db.insert(services).values({
      slug: 'svc', name: 'svc', asset: '0x' + 'a'.repeat(40), router: ROUTER, creator: '0x' + '2'.repeat(40),
      upstreamUrl: 'https://upstream.example', priceUsdc: '10000', upstreamSecret: 's',
    });
    globalThis.fetch = upstream as unknown as typeof fetch;
  });
  afterAll(async () => { globalThis.fetch = realFetch; await close(); });
  beforeEach(() => { h.verify.mockClear(); h.settle.mockClear(); upstream.mockClear(); });

  const payload = () => ({
    x402Version: 2, resource: { url: 'http://x/s/svc/json' },
    accepted: { scheme: 'exact', network: 'eip155:143' },
    payload: { signature: '0x00', authorization: {} },
  }) as any;

  it('402 is readable by the SDK client (PAYMENT-REQUIRED) and keeps the legacy header', async () => {
    const res = await app.request('/s/svc/json');
    expect(res.status).toBe(402);
    const pr = sdk.getPaymentRequiredResponse(n => res.headers.get(n));
    expect(pr.accepts[0]).toMatchObject({ scheme: 'exact', network: 'eip155:143', amount: '10000', payTo: ROUTER });
    expect(res.headers.get('X-PAYMENT-REQUIRED')).toBe(res.headers.get('PAYMENT-REQUIRED'));
  });

  it('accepts the SDK v2 PAYMENT-SIGNATURE header and returns PAYMENT-RESPONSE with the settle tx', async () => {
    const headers = sdk.encodePaymentSignatureHeader(payload());
    expect(Object.keys(headers)).toEqual(['PAYMENT-SIGNATURE']);
    const res = await app.request('/s/svc/json', { headers });
    expect(res.status).toBe(200);
    expect(h.settle).toHaveBeenCalledOnce();
    const settle = sdk.getPaymentSettleResponse(n => res.headers.get(n));
    expect(settle.transaction).toBe('0x' + 'e'.repeat(64));
  });

  it('still accepts the legacy X-PAYMENT header', async () => {
    const res = await app.request('/s/svc/json', { headers: { 'X-PAYMENT': encodePaymentSignatureHeader(payload()) } });
    expect(res.status).toBe(200);
    expect(h.settle).toHaveBeenCalledOnce();
  });

  it('never settles when upstream fails', async () => {
    upstream.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const res = await app.request('/s/svc/json', { headers: sdk.encodePaymentSignatureHeader(payload()) });
    expect(res.status).toBe(502);
    expect(h.settle).not.toHaveBeenCalled();
    expect(res.headers.get('PAYMENT-RESPONSE')).toBeNull();
  });
});

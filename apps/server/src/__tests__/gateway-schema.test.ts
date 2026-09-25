/**
 * Gateway: settle only after upstream 2xx AND a responseSchema pass (SPEC §9); upstream path
 * prefixes confine each service to its own endpoints (lib/upstream.ts).
 * Regression: nullfeed and nullsight shared the upstream base http://127.0.0.1:4001, so
 * /s/nullfeed/sight/signals returned SIGHT data and would have charged FEED's router.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { createTestDb, type TestDb } from './helpers/pgliteDb.js';

const h = vi.hoisted(() => ({
  db: null as unknown,
  verify: vi.fn(async () => ({ isValid: true, payer: '0xAbCdEf0000000000000000000000000000000009' })),
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

const { services, gatewayRequests } = await import('../db/schema.js');
const { desc } = await import('drizzle-orm');
const { encodePaymentSignatureHeader } = await import('@x402/core/http');
const gateway = (await import('../routes/gateway.js')).default;
const { buildUpstreamUrl, upstreamBaseError } = await import('../lib/upstream.js');
const { checkResponse, compileResponseSchema } = await import('../lib/responseSchema.js');

const schema = (f: string) => JSON.stringify(JSON.parse(readFileSync(new URL(`../../../demo-services/schemas/${f}`, import.meta.url), 'utf8')));
const SIGHT_SCHEMA = schema('sight-signals.json');
const FEED_SCHEMA = schema('feed-digest.json');
const sightBody = {
  handle: 'monad', source: 'sample data', notice: 'sample',
  signals: [1, 2, 3, 4, 5].map((r) => ({ rank: r, id: `s0${r}`, kind: 'mention', text: 't', score: 50 })),
};

const app = new Hono();
app.route('/s', gateway);
const latest = async () => (await (h.db as TestDb).select().from(gatewayRequests).orderBy(desc(gatewayRequests.createdAt)).limit(1))[0]!;
const paid = (path: string) => app.request(path, { headers: { 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader({
  x402Version: 2, resource: { url: 'http://x' }, accepted: { scheme: 'exact', network: 'eip155:143' },
  payload: { signature: '0x00', authorization: { from: '0xAbCdEf0000000000000000000000000000000009', to: '0x' + '5'.repeat(40), value: '10000' } },
} as never) } });

describe('gateway: response schema before settle, upstream path prefix', () => {
  let db: TestDb; let close: () => Promise<void>;
  const upstream = vi.fn(async (_url: string) => new Response(JSON.stringify(sightBody), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const realFetch = globalThis.fetch;
  const svc = (slug: string, upstreamUrl: string, responseSchema: string | null) => ({
    slug, name: slug, asset: '0x' + 'a'.repeat(40), router: '0x' + '5'.repeat(40), creator: '0x' + '2'.repeat(40),
    upstreamUrl, priceUsdc: '10000', upstreamSecret: 's', responseSchema,
  });

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    h.db = db;
    await db.insert(services).values([
      svc('sightsvc', 'https://up.example/sight', SIGHT_SCHEMA),
      svc('feedshared', 'https://up.example', FEED_SCHEMA),     // the mainnet bug: shared base, FEED schema
      svc('noschema', 'https://up.example/', null),
    ]);
    globalThis.fetch = upstream as unknown as typeof fetch;
  });
  afterAll(async () => { globalThis.fetch = realFetch; await close(); });
  beforeEach(() => { h.verify.mockClear(); h.settle.mockClear(); upstream.mockClear(); });

  it('match: body passes the schema → settled, prefix applied, query kept', async () => {
    const res = await paid('/s/sightsvc/signals?handle=monad&x=1&x=2');
    expect(res.status).toBe(200);
    expect(upstream.mock.calls[0]![0]).toBe('https://up.example/sight/signals?handle=monad&x=1&x=2');
    expect(h.settle).toHaveBeenCalledOnce();
    expect(await res.json()).toEqual(sightBody);
    expect(await latest()).toMatchObject({ settled: true, errorCode: null });
  });

  it('mismatch: SIGHT data under the FEED service → 502, not settled (the mainnet bug)', async () => {
    const res = await paid('/s/feedshared/sight/signals?handle=monad');
    expect(res.status).toBe(502);
    const body = await res.json() as { reason: string; error: string };
    expect(body.reason).toBe('schema_mismatch');
    expect(body.error).toMatch(/not charged/);
    expect(h.settle).not.toHaveBeenCalled();
    expect(await latest()).toMatchObject({ settled: false, errorCode: 'schema_mismatch' });
  });

  it('non-JSON body with a schema → 502 response_not_json, not settled', async () => {
    upstream.mockImplementationOnce(async () => new Response('<html>hi</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    const res = await paid('/s/sightsvc/signals?handle=monad');
    expect(res.status).toBe(502);
    expect((await res.json() as { reason: string }).reason).toBe('response_not_json');
    expect(h.settle).not.toHaveBeenCalled();
    expect(await latest()).toMatchObject({ settled: false, errorCode: 'response_not_json' });
  });

  it('no schema → unchanged: any 2xx settles', async () => {
    upstream.mockImplementationOnce(async () => new Response('plain', { status: 200 }));
    const res = await paid('/s/noschema/anything');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('plain');
    expect(upstream.mock.calls[0]![0]).toBe('https://up.example/anything');
    expect(h.settle).toHaveBeenCalledOnce();
  });

  it('paths that would leave the prefix are refused before any payment or upstream call', async () => {
    for (const p of ['/s/sightsvc/..%2Ffeed/digest', '/s/sightsvc/%2e%2e%2ffeed', '/s/sightsvc/a%5C..%5Cfeed']) {
      const res = await app.request(p);
      expect(res.status, p).toBe(400);
    }
    // "/s/sightsvc/../x" is normalised by the URL parser to /s/x (another slug), never to /feed on the upstream
    expect((await app.request('/s/sightsvc/../feed/digest')).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
    expect(h.verify).not.toHaveBeenCalled();
  });

  it('buildUpstreamUrl confines to the prefix', () => {
    expect(buildUpstreamUrl('http://127.0.0.1:4001/sight', '/signals', '?handle=a')?.toString()).toBe('http://127.0.0.1:4001/sight/signals?handle=a');
    expect(buildUpstreamUrl('http://127.0.0.1:4001/sight/', '', '')?.toString()).toBe('http://127.0.0.1:4001/sight/');
    expect(buildUpstreamUrl('http://127.0.0.1:4001', '/sight/signals', '')?.toString()).toBe('http://127.0.0.1:4001/sight/signals');
    expect(buildUpstreamUrl('http://127.0.0.1:4001/sight', '/../feed/digest', '')).toBeNull();
    expect(buildUpstreamUrl('http://127.0.0.1:4001/sight', '/./../feed', '')).toBeNull();
    expect(buildUpstreamUrl('http://127.0.0.1:4001/sight', '/%2E%2E/feed', '')).toBeNull();
    expect(buildUpstreamUrl('http://127.0.0.1:4001/sight', '//evil.example/x', '')?.origin).toBe('http://127.0.0.1:4001');
    expect(buildUpstreamUrl('http://127.0.0.1:4001/sight', 'signals', '')).toBeNull();
    // "/sightseeing" is not inside "/sight"
    expect(buildUpstreamUrl('http://127.0.0.1:4001/sight', '/../sightseeing', '')).toBeNull();
  });

  it('upstreamBaseError and compileResponseSchema reject unusable input at registration', () => {
    expect(upstreamBaseError('http://127.0.0.1:4001/sight')).toBeNull();
    expect(upstreamBaseError('http://127.0.0.1:4001/sight?k=1')).toMatch(/query/);
    expect(upstreamBaseError('http://127.0.0.1:4001/sight#x')).toMatch(/fragment/);
    expect(upstreamBaseError('http://u:p@127.0.0.1:4001/')).toMatch(/credentials/);
    expect(upstreamBaseError('http://127.0.0.1:4001/a%2Fb')).toMatch(/encoded/);
    expect(() => compileResponseSchema('{not json')).toThrow(/not valid JSON/);
    expect(() => compileResponseSchema('[1]')).toThrow(/JSON Schema object/);
    expect(() => compileResponseSchema(FEED_SCHEMA)).not.toThrow();
    expect(checkResponse('{"type":"object"}', new TextEncoder().encode('[]'))).toMatchObject({ ok: false, code: 'schema_mismatch' });
    expect(checkResponse(null, new TextEncoder().encode('x'))).toEqual({ ok: true });
  });
});

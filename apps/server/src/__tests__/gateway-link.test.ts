/**
 * Gateway on a "one API link" service, against a real local upstream: any method / body / content type, SSE streamed
 * and charged when its headers arrive, files, sessions, header stripping, redirect rewriting, the creator's API key and
 * the protect secret added, never charging non-2xx, size limits.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { createTestDb, type TestDb } from './helpers/pgliteDb.js';
import { startTestUpstream, json } from './helpers/testUpstream.js';

const h = vi.hoisted(() => {
  process.env.ALLOW_LOCAL_UPSTREAMS = 'true';
  process.env.GATEWAY_HMAC_MASTER_KEY = 'ab'.repeat(32);
  return {
    db: null as unknown,
    order: [] as string[],
    verify: vi.fn(async () => ({ isValid: true, payer: '0xAbCdEf0000000000000000000000000000000009' })),
    settle: vi.fn(async () => ({ success: true, transaction: '0x' + 'e'.repeat(64), network: 'eip155:143', payer: '0x' + '1'.repeat(40) })),
  };
});
vi.mock('../db/client.js', () => ({ get db() { return h.db; } }));
vi.mock('../env.js', () => ({
  FACILITATOR_URL: 'http://facilitator.invalid', USDC_ADDR: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', CHAIN_ID: 143, PAYMENT_TIMEOUT_S: 60,
}));
vi.mock('@x402/core/http', async (orig) => ({
  ...(await orig<typeof import('@x402/core/http')>()),
  HTTPFacilitatorClient: class { verify = h.verify; settle = h.settle; },
}));

const { services, gatewayRequests } = await import('../db/schema.js');
const { desc, eq } = await import('drizzle-orm');
const { encodePaymentSignatureHeader, decodePaymentRequiredHeader } = await import('@x402/core/http');
const gateway = (await import('../routes/gateway.js')).default;
const { encryptSecret } = await import('../lib/secretBox.js');
const { parseApiLink, PROTECT_HEADER } = await import('@astralaunch/shared');

const app = new Hono();
app.route('/s', gateway);
const PAY = { 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader({
  x402Version: 2, resource: { url: 'http://x' }, accepted: { scheme: 'exact', network: 'eip155:143' },
  payload: { signature: '0x00', authorization: { from: '0xAbCdEf0000000000000000000000000000000009', to: '0x' + '5'.repeat(40), value: '20000' } },
} as never) };
const latest = async () => (await (h.db as TestDb).select().from(gatewayRequests).orderBy(desc(gatewayRequests.createdAt)).limit(1))[0]!;
const SVC_ID = '11111111-2222-4333-8444-555555555555';

describe('gateway: one API link service', () => {
  let db: TestDb; let close: () => Promise<void>;
  let up: Awaited<ReturnType<typeof startTestUpstream>>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    h.db = db;
    up = await startTestUpstream(json({ answer: 42 }));
    const link = parseApiLink(`${up.url}/v1/ask?q=hello`);
    if (!link.ok) throw new Error(link.error);
    await db.insert(services).values({
      id: SVC_ID, slug: 'myagent', name: 'My agent', asset: '0x' + 'a'.repeat(40), router: '0x' + '5'.repeat(40), creator: '0x' + '2'.repeat(40),
      upstreamUrl: link.link.upstreamUrl, examplePath: link.link.examplePath, apiLink: `${up.url}/v1/ask?q=hello`,
      priceUsdc: '20000', upstreamSecret: 'hmac-secret', protectSecret: 'as_protect', timeoutSeconds: 120,
      apiKeyHeader: 'X-Api-Key', apiKeyEnc: encryptSecret('creator-key-123', SVC_ID),
    });
    h.settle.mockImplementation(async () => { h.order.push('settle'); return { success: true, transaction: '0x' + 'e'.repeat(64), network: 'eip155:143', payer: '0x' + '1'.repeat(40) }; });
  });
  afterAll(async () => { await up.close(); await close(); });
  beforeEach(() => { h.verify.mockClear(); h.settle.mockClear(); h.order.length = 0; up.reset(); });

  it('402 carries a payment window that covers the 120 s upstream timeout', async () => {
    const res = await app.request('/s/myagent/ask?q=hello');
    expect(res.status).toBe(402);
    const pr = decodePaymentRequiredHeader(res.headers.get('PAYMENT-REQUIRED')!);
    expect(pr.accepts[0]!.maxTimeoutSeconds).toBe(150);
    expect(up.calls).toHaveLength(0);
  });

  it('JSON GET: path under the prefix, query kept, key + secret + signature added, charged after 2xx', async () => {
    const res = await app.request('/s/myagent/ask?q=hello&x=1', { headers: { ...PAY, 'x-api-key': 'agent-forged', cookie: 'gw=1' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ answer: 42 });
    const call = up.calls[0]!;
    expect(call.path).toBe('/v1/ask?q=hello&x=1');
    expect(call.headers['x-api-key']).toBe('creator-key-123');
    expect(call.headers[PROTECT_HEADER.toLowerCase()]).toBe('as_protect');
    expect(call.headers['x-astralaunch-signature']).toMatch(/^t=\d+;v1=[0-9a-f]{64}$/);
    expect(call.headers.cookie).toBeUndefined();
    expect(call.headers['payment-signature']).toBeUndefined();
    expect(h.settle).toHaveBeenCalledOnce();
    expect(await latest()).toMatchObject({ settled: true, upstreamStatus: 200 });
  });

  it('JSON POST: body forwarded byte for byte', async () => {
    up.set((req, r, body) => { r.writeHead(201, { 'content-type': 'application/json' }); r.end(JSON.stringify({ got: JSON.parse(body.toString()), method: req.method })); });
    const res = await app.request('/s/myagent/ask', { method: 'POST', headers: { ...PAY, 'content-type': 'application/json' }, body: JSON.stringify({ q: 'hi', n: [1, 2] }) });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ got: { q: 'hi', n: [1, 2] }, method: 'POST' });
    expect(h.settle).toHaveBeenCalledOnce();
  });

  it('SSE: charged when the 2xx headers arrive, before the body; bytes pass through unbuffered', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    up.set(async (_q, r) => {
      r.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      r.write('data: first\n\n');
      await gate;                                  // the rest only after the test saw the first event
      r.write('data: second\n\n');
      r.end();
    });
    const res = await app.request('/s/myagent/stream', { headers: PAY });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('PAYMENT-RESPONSE')).toBeTruthy();
    expect(h.settle).toHaveBeenCalledOnce();       // settled before the stream finished
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toBe('data: first\n\n');         // arrived while the upstream is still open
    release();
    let rest = '';
    for (let c = await reader.read(); !c.done; c = await reader.read()) rest += new TextDecoder().decode(c.value);
    expect(rest).toBe('data: second\n\n');
  });

  it('multipart upload with a binary (image) response', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 255]);
    up.set((req, r, body) => {
      const ok = /multipart\/form-data; boundary=/.test(String(req.headers['content-type'])) && body.includes(Buffer.from('hello-file'));
      r.writeHead(ok ? 200 : 400, { 'content-type': 'image/png', 'content-length': String(png.length), 'content-disposition': 'inline; filename="out.png"' });
      r.end(png);
    });
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('hello-file')], { type: 'text/plain' }), 'in.txt');
    form.append('note', 'x');
    const res = await app.request('/s/myagent/convert', { method: 'POST', headers: PAY, body: form });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-disposition')).toBe('inline; filename="out.png"');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(png);
    expect(h.settle).toHaveBeenCalledOnce();
  });

  it('session header round-trip (sent by the agent, returned by the API)', async () => {
    up.set((req, r) => {
      const sid = String(req.headers['x-session-id'] ?? 'new-session');
      r.writeHead(200, { 'content-type': 'application/json', 'x-session-id': sid });
      r.end(JSON.stringify({ sid }));
    });
    const first = await app.request('/s/myagent/chat', { headers: PAY });
    const sid = first.headers.get('x-session-id')!;
    expect(sid).toBe('new-session');
    const second = await app.request('/s/myagent/chat', { headers: { ...PAY, 'X-Session-Id': 'sess-77' } });
    expect(second.headers.get('x-session-id')).toBe('sess-77');
    expect(up.calls[1]!.headers['x-session-id']).toBe('sess-77');
  });

  it('upstream error: not charged, error scrubbed of the upstream host', async () => {
    up.set((_q, r) => { r.writeHead(404, { 'content-type': 'application/json' }); r.end(JSON.stringify({ error: `no route on ${up.url}/v1/nope` })); });
    const res = await app.request('/s/myagent/nope', { headers: PAY });
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string; upstreamStatus: number; upstreamBody: string };
    expect(body).toMatchObject({ upstreamStatus: 404 });
    expect(body.error).toMatch(/not charged/);
    expect(body.upstreamBody).not.toContain('127.0.0.1');
    expect(body.upstreamBody).toContain('<upstream>');
    expect(h.settle).not.toHaveBeenCalled();
    expect(await latest()).toMatchObject({ settled: false, upstreamStatus: 404, errorCode: 'upstream_error' });
  });

  it('upstream unreachable: not charged, no host in the error', async () => {
    const dead = '22222222-2222-4333-8444-555555555555';
    await (h.db as TestDb).insert(services).values({
      id: dead, slug: 'dead', name: 'dead', asset: '0x' + 'a'.repeat(40), router: '0x' + '5'.repeat(40), creator: '0x' + '2'.repeat(40),
      upstreamUrl: 'http://127.0.0.1:9', apiLink: 'http://127.0.0.1:9/x', priceUsdc: '20000', upstreamSecret: 's', protectSecret: 'p',
    });
    const res = await app.request('/s/dead/x', { headers: PAY });
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toMatch(/127\.0\.0\.1|:9/);
    expect(h.settle).not.toHaveBeenCalled();
  });

  it('redirects: not charged; Location rewritten to the gateway; fingerprint headers stripped', async () => {
    up.set((_q, r) => { r.writeHead(302, { location: '/v1/result/9', server: 'nginx', 'x-powered-by': 'Express' }); r.end(); });
    const res = await app.request('/s/myagent/job', { headers: PAY });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/\/s\/myagent\/result\/9$/);
    expect(res.headers.get('server')).toBeNull();
    expect(res.headers.get('x-powered-by')).toBeNull();
    expect(h.settle).not.toHaveBeenCalled();
  });

  it('2xx responses never expose server fingerprints or cookies', async () => {
    up.set((_q, r) => { r.writeHead(200, { 'content-type': 'application/json', server: 'uvicorn', via: '1.1 x', 'set-cookie': 'a=b', 'x-amz-id': '1' }); r.end('{}'); });
    const res = await app.request('/s/myagent/ask', { headers: PAY });
    for (const k of ['server', 'via', 'set-cookie', 'x-amz-id']) expect(res.headers.get(k), k).toBeNull();
  });

  it('request body over the limit is refused before payment (413)', async () => {
    process.env.GATEWAY_MAX_REQUEST_BYTES = '1000';
    const res = await app.request('/s/myagent/ask', { method: 'POST', headers: { 'content-length': '5000', 'content-type': 'application/octet-stream' }, body: Buffer.alloc(5000) });
    delete process.env.GATEWAY_MAX_REQUEST_BYTES;
    expect(res.status).toBe(413);
    expect(up.calls).toHaveLength(0);
  });

  it('a path outside the prefix is refused before payment', async () => {
    expect((await app.request('/s/myagent/..%2Fadmin', { headers: PAY })).status).toBe(400);
    expect(up.calls).toHaveLength(0);
    expect(h.verify).not.toHaveBeenCalled();
  });

  it('the protect secret is generated on first use for services from before the migration', async () => {
    const legacy = '33333333-2222-4333-8444-555555555555';
    await (h.db as TestDb).insert(services).values({
      id: legacy, slug: 'legacy', name: 'legacy', asset: '0x' + 'a'.repeat(40), router: '0x' + '5'.repeat(40), creator: '0x' + '2'.repeat(40),
      upstreamUrl: `${up.url}/sight`, priceUsdc: '20000', upstreamSecret: 's',
    });
    await app.request('/s/legacy/signals', { headers: PAY });
    const [row] = await (h.db as TestDb).select().from(services).where(eq(services.id, legacy));
    expect(row!.protectSecret).toMatch(/^as_/);
    expect(up.calls.at(-1)!.headers[PROTECT_HEADER.toLowerCase()]).toBe(row!.protectSecret);
  });
});

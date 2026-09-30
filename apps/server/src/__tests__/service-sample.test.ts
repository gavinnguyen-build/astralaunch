/**
 * POST-only APIs in the one-link model: a link that answers 405 (or 404/400 only because the body is missing) is
 * reachable and may launch/attach with "no sample call"; an optional sample request (method + JSON body) drives the
 * check and "Try a sample call"; the token page gets sample null when there is none.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { createTestDb, type TestDb } from './helpers/pgliteDb.js';
import { startTestUpstream, type Handler } from './helpers/testUpstream.js';

const h = vi.hoisted(() => {
  process.env.ALLOW_LOCAL_UPSTREAMS = 'true';
  process.env.GATEWAY_HMAC_MASTER_KEY = 'ef'.repeat(32);
  return { db: null as unknown };
});
vi.mock('../db/client.js', () => ({ get db() { return h.db; } }));
vi.mock('../env.js', () => ({
  RPC_URL: 'http://127.0.0.1:1', CHAIN_ID: 143, SUBMITTERS: [], REGISTRY_ADDR: '0x0000000000000000000000000000000000000001',
  ESCROW_ADDR: '0x0000000000000000000000000000000000000002', VAULT_ADDR: '0x0000000000000000000000000000000000000003',
  USDC_ADDR: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', PAYMENT_TIMEOUT_S: 60,
}));

const { services, idxRegistrations } = await import('../db/schema.js');
const { eq } = await import('drizzle-orm');
const { upsertTokenFromRegistration } = await import('../services/tokenSync.js');
const { adminListAsset } = await import('../services/launchFee.js');
const shared = await import('@astralaunch/shared');
const { privateKeyToAccount } = await import('viem/accounts');
const servicesRouter = (await import('../routes/services.js')).default;
const tokensRouter = (await import('../routes/tokens.js')).default;
const { probeService } = await import('../lib/probes.js');
const { publicSample } = await import('../services/serviceLinks.js');

const creator = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');   // Anvil #0, tests only
const ASSET = '0x' + 'b'.repeat(40);
const app = new Hono();
app.route('/api/services', servicesRouter);
app.route('/api/tokens', tokensRouter);
const post = (path: string, body: unknown, method = 'POST') => app.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
let clock = Math.floor(Date.now() / 1000);
const next = () => ++clock;

/** A POST-only JSON chat API: GET → 405; POST without {"message"} → 422; POST with it → 200. */
const postOnly: Handler = (req, res, body) => {
  if (req.url?.split('?')[0] !== '/v1/chat') { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":"not found"}'); }
  if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' }); return res.end('{"error":"method not allowed"}'); }
  let j: { message?: string } = {};
  try { j = JSON.parse(body.toString() || '{}'); } catch { /* 422 below */ }
  if (!j.message) { res.writeHead(422, { 'content-type': 'application/json' }); return res.end('{"error":"message required"}'); }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ reply: `you said ${j.message}` }));
};

describe('shared: sample request fields', () => {
  it('body must be JSON ≤ 16 KB and only with POST; a sample needs apiLink', () => {
    expect(shared.sampleBodyError('{"a":1}')).toBeNull();
    expect(shared.sampleBodyError('not json')).toMatch(/valid JSON/);
    expect(shared.sampleBodyError(JSON.stringify({ x: 'é'.repeat(8200) }))).toMatch(/16 KB/);   // > 16 KB in UTF-8 bytes
    const base = { asset: ASSET, slug: 'abc', name: 'a', priceUsdc: '1', issuedAt: 1, signature: '0x00', apiLink: 'https://x.ai/v1/chat' };
    expect(shared.createServiceSchema.safeParse({ ...base, sampleMethod: 'POST', sampleBody: '{"message":"hi"}' }).success).toBe(true);
    expect(shared.createServiceSchema.safeParse({ ...base, sampleMethod: 'GET', sampleBody: '{}' }).success).toBe(false);
    expect(shared.createServiceSchema.safeParse({ ...base, sampleBody: '{}' }).success).toBe(false);
    expect(shared.createServiceSchema.safeParse({ ...base, sampleMethod: 'PUT' }).success).toBe(false);
    expect(shared.updateServiceSchema.safeParse({ sampleMethod: '', issuedAt: 1, signature: '0x00' }).success).toBe(true);
  });
  it('messages without a sample are unchanged; the sample fields are signed', () => {
    const m = { asset: ASSET, slug: 'abc', name: 'a', priceUsdc: '1', apiLink: 'https://x.ai/v1/chat', issuedAt: 1 };
    expect(shared.serviceCreateMessage(m)).toBe(`Astralaunch: register service\n{"asset":"${ASSET}","slug":"abc","name":"a","priceUsdc":"1","apiLink":"https://x.ai/v1/chat","issuedAt":1}`);
    expect(shared.serviceCreateMessage({ ...m, sampleMethod: 'POST', sampleBody: '{"message":"hi"}' }))
      .toContain('"sampleMethod":"POST","sampleBody":"{\\"message\\":\\"hi\\"}","issuedAt":1');
  });
  it('publicSample: none without a checked response on link services; legacy GET example kept', () => {
    expect(publicSample({ apiLink: 'https://x', examplePath: '/chat', responseKind: null, sampleMethod: null, sampleBody: null })).toBeNull();
    expect(publicSample({ apiLink: 'https://x', examplePath: '/chat', responseKind: 'json', sampleMethod: 'POST', sampleBody: '{}' })).toEqual({ method: 'POST', path: '/chat', body: '{}' });
    expect(publicSample({ apiLink: null, examplePath: '/signals?h=1', responseKind: null, sampleMethod: null, sampleBody: null })).toEqual({ method: 'GET', path: '/signals?h=1', body: null });
  });
});

describe('POST-only API', () => {
  let db: TestDb; let close: () => Promise<void>;
  let up: Awaited<ReturnType<typeof startTestUpstream>>;
  let id = '';
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    h.db = db;
    up = await startTestUpstream(postOnly);
    const reg = {
      chainId: 143, txHash: '0x' + '2'.repeat(64), logIndex: 0, asset: ASSET, creator: creator.address.toLowerCase(), router: '0x' + '6'.repeat(40),
      poolId: '0x00', numeraire: '', initializer: '', launcher: '0x' + '9'.repeat(40), blockNumber: 10n, timestamp: 1_800_000_000n,
    };
    await db.insert(idxRegistrations).values(reg);
    await upsertTokenFromRegistration(db, reg, { name: 'Chat', symbol: 'CHAT', decimals: 18 });
    await adminListAsset(db, ASSET, 143, 'test');
  });
  afterAll(async () => { await up.close(); await close(); });
  beforeEach(() => up.reset());

  it('check: GET 405 → reachable, no sample call (launch allowed)', async () => {
    const res = await post('/api/services/check', { apiLink: `${up.url}/v1/chat` });
    expect(res.status).toBe(200);
    const b = await res.json() as { ok: boolean; kind: string | null; noSample: string };
    expect(b).toMatchObject({ ok: true, kind: null, status: 405 });
    expect(b.noSample).toMatch(/No sample call/);
  });

  it('check: GET 404 but the path answers POST (422) → reachable; 404 on both → refused', async () => {
    up.set((req, res, body) => req.method === 'GET' ? (res.writeHead(404), res.end()) : postOnly(req, res, body));
    expect(await (await post('/api/services/check', { apiLink: `${up.url}/v1/chat` })).json()).toMatchObject({ ok: true, kind: null, status: 404 });
    expect(up.calls.map((c) => `${c.method} ${c.body.toString()}`)).toEqual(['GET ', 'POST {}']);
    up.set((_q, res) => { res.writeHead(404); res.end(); });
    const r = await post('/api/services/check', { apiLink: `${up.url}/v1/nothing` });
    expect(r.status).toBe(422);
    expect((await r.json() as { error: string }).error).toBe('It answered with an error (404).');
  });

  it('check with a POST sample: the body is sent as JSON and the response recorded; a failing sample is refused', async () => {
    const ok = await (await post('/api/services/check', { apiLink: `${up.url}/v1/chat`, sampleMethod: 'POST', sampleBody: '{"message":"hi"}' })).json() as { kind: string; sample: string };
    expect(ok).toMatchObject({ ok: true, kind: 'json' });
    expect(JSON.parse(ok.sample)).toEqual({ reply: 'you said hi' });
    expect(up.calls[0]).toMatchObject({ method: 'POST' });
    expect(up.calls[0]!.headers['content-type']).toBe('application/json');
    const bad = await post('/api/services/check', { apiLink: `${up.url}/v1/chat`, sampleMethod: 'POST', sampleBody: '{"other":1}' });
    expect(bad.status).toBe(422);
    expect((await bad.json() as { error: string }).error).toBe('Your sample request got an error (422).');
  });

  it('create without a sample: allowed; the token page gets sample null (agent link still there)', async () => {
    const m = { asset: ASSET, slug: 'chatsvc', name: 'Chat', priceUsdc: '20000', apiLink: `${up.url}/v1/chat`, issuedAt: next() };
    const res = await post('/api/services', { ...m, signature: await creator.signMessage({ message: shared.serviceCreateMessage(m) }) });
    expect(res.status).toBe(201);
    id = (await res.json() as { id: string }).id;
    const [row] = await db.select().from(services).where(eq(services.id, id));
    expect(row).toMatchObject({ responseKind: null, sampleMethod: null, examplePath: '/chat' });
    const detail = await (await app.request(`/api/tokens/${ASSET}`)).json() as { service: { endpoint: string; sample: unknown; response: unknown } };
    expect(detail.service).toMatchObject({ endpoint: '/s/chatsvc', sample: null, response: null });
    const man = await (await app.request('/api/services/chatsvc/manifest')).json() as { sample: unknown };
    expect(man.sample).toBeNull();
  }, 60_000);

  it('probe without a sample: 405 is healthy-reachable; protection unknown until the API answers 401', async () => {
    const [svc] = await db.select().from(services).where(eq(services.id, id));
    expect(await probeService(db, svc!)).toMatchObject({ health: 405, direct: 405 });
    expect((await db.select().from(services).where(eq(services.id, id)))[0]!.protectionStatus).toBeNull();
    up.set((req, res, body) => req.headers['x-astralaunch-secret'] ? postOnly(req, res, body) : (res.writeHead(401), res.end()));
    await probeService(db, svc!);
    expect((await db.select().from(services).where(eq(services.id, id)))[0]!.protectionStatus).toBe('protected');
  });

  it('PATCH adds a POST sample (checked with it), then "" removes it', async () => {
    const add = { sampleMethod: 'POST' as const, sampleBody: '{"message":"hello"}', issuedAt: next() };
    const r1 = await post(`/api/services/${id}`, { ...add, signature: await creator.signMessage({ message: shared.serviceUpdateMessage(id, ASSET, add) }) }, 'PATCH');
    expect(r1.status).toBe(200);
    expect((await r1.json() as { sample: unknown }).sample).toEqual({ method: 'POST', path: '/chat', body: '{"message":"hello"}' });
    const detail = await (await app.request(`/api/tokens/${ASSET}`)).json() as { service: { sample: unknown; response: { kind: string; sample: string } } };
    expect(detail.service.sample).toEqual({ method: 'POST', path: '/chat', body: '{"message":"hello"}' });
    expect(JSON.parse(detail.service.response.sample)).toEqual({ reply: 'you said hello' });

    const rm = { sampleMethod: '' as const, issuedAt: next() };
    const r2 = await post(`/api/services/${id}`, { ...rm, signature: await creator.signMessage({ message: shared.serviceUpdateMessage(id, ASSET, rm) }) }, 'PATCH');
    expect(r2.status).toBe(200);
    const [row] = await db.select().from(services).where(eq(services.id, id));
    expect(row).toMatchObject({ sampleMethod: null, sampleBody: null, responseKind: null });
  }, 60_000);

  it('a sample on a legacy (no link) service is refused', async () => {
    const [legacy] = await db.insert(services).values({
      slug: 'legacy2', name: 'l', asset: ASSET, router: '0x' + '6'.repeat(40), creator: creator.address.toLowerCase(),
      upstreamUrl: `${up.url}/v1`, priceUsdc: '1', upstreamSecret: 's',
    }).returning();
    const m = { sampleMethod: 'POST' as const, sampleBody: '{}', issuedAt: next() };
    const r = await post(`/api/services/${legacy!.id}`, { ...m, signature: await creator.signMessage({ message: shared.serviceUpdateMessage(legacy!.id, ASSET, m) }) }, 'PATCH');
    expect(r.status).toBe(400);
    expect((await r.json() as { error: string }).error).toMatch(/needs an API link/);
  });
});

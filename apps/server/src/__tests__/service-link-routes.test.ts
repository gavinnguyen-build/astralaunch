/**
 * Service routes for the "one API link" model against a real local upstream: the link check (kinds and human errors),
 * signed create / update with apiLink and an API key, the signed settings read, NO public endpoint returning the
 * link / key / secret, old signed messages still valid, and the protection probe.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { createTestDb, type TestDb } from './helpers/pgliteDb.js';
import { startTestUpstream, json } from './helpers/testUpstream.js';

const h = vi.hoisted(() => {
  process.env.ALLOW_LOCAL_UPSTREAMS = 'true';
  process.env.GATEWAY_HMAC_MASTER_KEY = 'cd'.repeat(32);
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
const creatorRouter = (await import('../routes/creator.js')).default;
const { probeService } = await import('../lib/probes.js');

// Anvil dev key, tests only.
const creator = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const ASSET = '0x' + 'a'.repeat(40);
const ROUTER = '0x' + '5'.repeat(40);

const app = new Hono();
app.route('/api/services', servicesRouter);
app.route('/api/tokens', tokensRouter);
app.route('/api/creator', creatorRouter);
const post = (path: string, body: unknown, method = 'POST') => app.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const now = () => Math.floor(Date.now() / 1000);

describe('one API link: service routes', () => {
  let db: TestDb; let close: () => Promise<void>;
  let up: Awaited<ReturnType<typeof startTestUpstream>>;
  let serviceId = '';

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    h.db = db;
    up = await startTestUpstream(json({ answer: 42, text: 'hello' }));
    const reg = {
      chainId: 143, txHash: '0x' + '1'.repeat(64), logIndex: 0, asset: ASSET, creator: creator.address.toLowerCase(), router: ROUTER,
      poolId: '0x00', numeraire: '', initializer: '', launcher: '0x' + '9'.repeat(40), blockNumber: 10n, timestamp: 1_800_000_000n,
    };
    await db.insert(idxRegistrations).values(reg);
    await upsertTokenFromRegistration(db, reg, { name: 'T', symbol: 'MYAG', decimals: 18 });
    await adminListAsset(db, ASSET, 143, 'test');
  });
  afterAll(async () => { await up.close(); await close(); });
  beforeEach(() => up.reset());

  describe('POST /api/services/check', () => {
    it('JSON: 2xx, kind json, a small pretty sample, derived prefix and example', async () => {
      const res = await post('/api/services/check', { apiLink: `${up.url}/v1/ask?q=hello` });
      expect(res.status).toBe(200);
      const b = await res.json() as Record<string, unknown>;
      expect(b).toMatchObject({ ok: true, kind: 'json', prefix: '/v1/', examplePath: '/ask?q=hello', status: 200 });
      expect(JSON.parse(b.sample as string)).toEqual({ answer: 42, text: 'hello' });
      expect(up.calls[0]!.path).toBe('/v1/ask?q=hello');
    });
    it('large JSON: sample truncated to a few KB', async () => {
      up.set(json({ big: 'x'.repeat(20_000) }));
      const b = await (await post('/api/services/check', { apiLink: `${up.url}/v1/ask` })).json() as { sample: string; sampleTruncated: boolean };
      expect(b.sample.length).toBeLessThanOrEqual(4096);
      expect(b.sampleTruncated).toBe(true);
    });
    it('stream and file: only the type is kept', async () => {
      up.set((_q, r) => { r.writeHead(200, { 'content-type': 'text/event-stream' }); r.write('data: 1\n\n'); setTimeout(() => r.end(), 50); });
      expect(await (await post('/api/services/check', { apiLink: `${up.url}/s` })).json()).toMatchObject({ ok: true, kind: 'stream', sample: null });
      up.set((_q, r) => { r.writeHead(200, { 'content-type': 'image/png', 'content-length': '3' }); r.end(Buffer.from([1, 2, 3])); });
      expect(await (await post('/api/services/check', { apiLink: `${up.url}/img` })).json()).toMatchObject({ ok: true, kind: 'file', contentType: 'image/png', sample: null });
    });
    it('human-readable failures: error status, redirect, unreachable, timeout, bad link', async () => {
      up.set(json({ e: 1 }, 404));
      expect(await (await post('/api/services/check', { apiLink: `${up.url}/x` })).json()).toMatchObject({ ok: false, error: 'It answered with an error (404).' });
      up.set((_q, r) => { r.writeHead(302, { location: '/y' }); r.end(); });
      expect((await (await post('/api/services/check', { apiLink: `${up.url}/x` })).json() as { error: string }).error).toMatch(/redirected/);
      expect((await (await post('/api/services/check', { apiLink: 'http://127.0.0.1:9/x' })).json() as { error: string }).error).toBe('We could not reach this link. Check the address and that your API is online.');
      process.env.GATEWAY_TIMEOUT_S = '1';
      up.set(async (_q, r) => { await new Promise((z) => setTimeout(z, 1500)); r.end('{}'); });
      const t = await post('/api/services/check', { apiLink: `${up.url}/slow` });
      delete process.env.GATEWAY_TIMEOUT_S;
      expect(t.status).toBe(422);
      expect((await t.json() as { error: string }).error).toBe('It took longer than 1 seconds to answer.');
      expect((await (await post('/api/services/check', { apiLink: 'not a link' })).json() as { error: string }).error).toMatch(/not a valid link/);
    });
  });

  describe('create, settings, update', () => {
    it('signed create with apiLink + API key: derived upstream/example, response stored, key encrypted', async () => {
      const m = {
        asset: ASSET, slug: 'myag', name: 'My agent', priceUsdc: '20000', apiLink: `${up.url}/v1/ask?q=hello`,
        apiKeyHeader: 'X-Api-Key', apiKeyValue: 'sk-creator-1', issuedAt: now(),
      };
      const res = await post('/api/services', { ...m, signature: await creator.signMessage({ message: shared.serviceCreateMessage(m) }) });
      expect(res.status).toBe(201);
      serviceId = (await res.json() as { id: string }).id;
      const [row] = await db.select().from(services).where(eq(services.id, serviceId));
      expect(row).toMatchObject({
        upstreamUrl: `${up.url}/v1`, examplePath: '/ask?q=hello', apiLink: m.apiLink, wholeDomain: false, apiKeyHeader: 'X-Api-Key',
        responseKind: 'json', timeoutSeconds: 120,
      });
      expect(row!.apiKeyEnc).toMatch(/^v1:/);
      expect(row!.apiKeyEnc).not.toContain('sk-creator-1');
      expect(row!.protectSecret).toMatch(/^as_/);
      expect(up.calls[0]!.headers['x-api-key']).toBe('sk-creator-1');   // the check used the key
    });

    it('a failing link is refused at create (422, human message) and nothing is stored', async () => {
      up.set(json({}, 500));
      const m = { asset: ASSET, slug: 'broken', name: 'b', priceUsdc: '20000', apiLink: `${up.url}/v1/x`, issuedAt: now() };
      const res = await post('/api/services', { ...m, signature: await creator.signMessage({ message: shared.serviceCreateMessage(m) }) });
      expect(res.status).toBe(422);
      expect((await res.json() as { error: string }).error).toBe('It answered with an error (500).');
      expect(await db.select().from(services).where(eq(services.slug, 'broken'))).toHaveLength(0);
    });

    it('settings: only the signed creator sees the link, the key header (never its value) and the secret', async () => {
      const issuedAt = now();
      const sig = await creator.signMessage({ message: shared.serviceSettingsMessage(serviceId, ASSET, issuedAt) });
      const res = await post(`/api/services/${serviceId}/settings`, { issuedAt, signature: sig });
      expect(res.status).toBe(200);
      const b = await res.json() as Record<string, any>;
      expect(b).toMatchObject({ apiLink: `${up.url}/v1/ask?q=hello`, apiKey: { header: 'X-Api-Key', set: true }, protect: { header: 'X-Astralaunch-Secret' } });
      expect(b.protect.secret).toMatch(/^as_/);
      expect(JSON.stringify(b)).not.toContain('sk-creator-1');
      const other = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
      const bad = await post(`/api/services/${serviceId}/settings`, { issuedAt, signature: await other.signMessage({ message: shared.serviceSettingsMessage(serviceId, ASSET, issuedAt) }) });
      expect(bad.status).toBe(403);
    });

    it('NO public endpoint returns the link, the upstream, the key or a secret', async () => {
      const [row] = await db.select().from(services).where(eq(services.id, serviceId));
      const forbidden = [up.url, '127.0.0.1', 'sk-creator-1', row!.protectSecret!, row!.upstreamSecret, row!.apiKeyEnc!];
      for (const path of [`/api/tokens/${ASSET}`, '/api/tokens?filter=all', `/api/services/myag/manifest`, `/api/creator/${creator.address}`]) {
        const res = await app.request(path);
        expect(res.status, path).toBe(200);   // a real body, not an error page
        const text = await res.text();
        for (const f of forbidden) expect(text.includes(f), `${path} leaks ${f.slice(0, 12)}…`).toBe(false);
      }
      const detail = await (await app.request(`/api/tokens/${ASSET}`)).json() as { service: { response: { kind: string; sample: string } } };
      expect(detail.service.response.kind).toBe('json');
      expect(JSON.parse(detail.service.response.sample)).toEqual({ answer: 42, text: 'hello' });
    }, 120_000);   // detail/creator also try on-chain reads against the test RPC (refused, retried)

    it('signed update with a new link (+ whole domain) re-runs the check with the service\'s own headers; PATCH response has no private fields', async () => {
      const m = { apiLink: `${up.url}/v2/run?x=1`, wholeDomain: true, issuedAt: now() + 1 };
      const res = await post(`/api/services/${serviceId}`, { ...m, signature: await creator.signMessage({ message: shared.serviceUpdateMessage(serviceId, ASSET, m) }) }, 'PATCH');
      expect(res.status).toBe(200);
      const text = await res.text();
      for (const f of [up.url, 'sk-creator-1', 'as_']) expect(text.includes(f), f).toBe(false);
      const call = up.calls.at(-1)!;
      expect(call.path).toBe('/v2/run?x=1');
      expect(call.headers['x-astralaunch-secret']).toMatch(/^as_/);
      expect(call.headers['x-api-key']).toBe('sk-creator-1');          // the stored key is kept and used
      const [row] = await db.select().from(services).where(eq(services.id, serviceId));
      expect(row).toMatchObject({ upstreamUrl: up.url, examplePath: '/v2/run?x=1', wholeDomain: true });
    });

    it('removing the API key ("" header)', async () => {
      const m = { apiKeyHeader: '', issuedAt: now() + 2 };
      const res = await post(`/api/services/${serviceId}`, { ...m, signature: await creator.signMessage({ message: shared.serviceUpdateMessage(serviceId, ASSET, m) }) }, 'PATCH');
      expect(res.status).toBe(200);
      const [row] = await db.select().from(services).where(eq(services.id, serviceId));
      expect(row!.apiKeyHeader).toBeNull();
      expect(row!.apiKeyEnc).toBeNull();
    });

    it('moving a legacy (upstreamUrl) service to a link with a signed update', async () => {
      const [legacy] = await db.insert(services).values({
        slug: 'legacy', name: 'legacy', asset: ASSET, router: ROUTER, creator: creator.address.toLowerCase(),
        upstreamUrl: `${up.url}/sight`, priceUsdc: '20000', upstreamSecret: 's', examplePath: '/signals?handle=monad',
      }).returning();
      const m = { apiLink: `${up.url}/sight/signals?handle=monad`, issuedAt: now() };
      const res = await post(`/api/services/${legacy!.id}`, { ...m, signature: await creator.signMessage({ message: shared.serviceUpdateMessage(legacy!.id, ASSET, m) }) }, 'PATCH');
      expect(res.status).toBe(200);
      const [row] = await db.select().from(services).where(eq(services.id, legacy!.id));
      expect(row).toMatchObject({ upstreamUrl: `${up.url}/sight`, examplePath: '/signals?handle=monad', apiLink: m.apiLink, responseKind: 'json', timeoutSeconds: 120 });
    });
  });

  describe('old signed messages stay valid', () => {
    it('messages without the new fields are byte-identical to the previous format', () => {
      const create = { asset: ASSET, slug: 'nullsight', name: 'n', upstreamUrl: 'http://demo-services:4001/sight', priceUsdc: '1', issuedAt: 1 };
      expect(shared.serviceCreateMessage(create)).toBe(
        `Astralaunch: register service\n{"asset":"${ASSET}","slug":"nullsight","name":"n","upstreamUrl":"http://demo-services:4001/sight","priceUsdc":"1","issuedAt":1}`);
      expect(shared.serviceUpdateMessage('id-1', ASSET, { priceUsdc: '2', issuedAt: 3 })).toBe(
        `Astralaunch: update service\n{"serviceId":"id-1","asset":"${ASSET}","priceUsdc":"2","issuedAt":3}`);
    });
    it('schemas: apiLink xor upstreamUrl; reserved key headers refused', () => {
      expect(shared.createServiceSchema.safeParse({ asset: ASSET, slug: 'abc', name: 'a', priceUsdc: '1', issuedAt: 1, signature: '0x00' }).success).toBe(false);
      expect(shared.createServiceSchema.safeParse({ asset: ASSET, slug: 'abc', name: 'a', priceUsdc: '1', issuedAt: 1, signature: '0x00', apiLink: 'https://x.ai/a', upstreamUrl: 'https://x.ai' }).success).toBe(false);
      for (const hdr of ['Host', 'Cookie', 'X-Astralaunch-Secret', 'Payment-Signature', 'X-Forwarded-For']) {
        expect(shared.createServiceSchema.safeParse({ asset: ASSET, slug: 'abc', name: 'a', priceUsdc: '1', issuedAt: 1, signature: '0x00', apiLink: 'https://x.ai/a', apiKeyHeader: hdr, apiKeyValue: 'v' }).success, hdr).toBe(false);
      }
    });
  });

  describe('protection probe', () => {
    it('flags "unprotected" when a direct call (no secret) answers 2xx, "protected" once the API checks the secret', async () => {
      const [svc] = await db.select().from(services).where(eq(services.id, serviceId));
      up.set(json({ ok: true }));                                   // accepts anyone
      expect(await probeService(db, svc!)).toMatchObject({ health: 200, direct: 200 });
      expect((await db.select().from(services).where(eq(services.id, serviceId)))[0]).toMatchObject({ protectionStatus: 'unprotected' });
      up.set((req, r) => {                                          // the Node snippet's rule
        const ok = req.headers['x-astralaunch-secret'] === svc!.protectSecret;
        r.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' }); r.end(ok ? '{"ok":true}' : '{"error":"unauthorized"}');
      });
      const [fresh] = await db.select().from(services).where(eq(services.id, serviceId));
      expect(await probeService(db, fresh!)).toMatchObject({ health: 200, direct: 401 });
      expect((await db.select().from(services).where(eq(services.id, serviceId)))[0]).toMatchObject({ protectionStatus: 'protected' });
    });
  });
});

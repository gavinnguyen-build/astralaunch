/**
 * Response schemas that go stale (D-SV4): the creator can replace or remove the stored schema with a signed update
 * (old signed messages unchanged), and responses that fail it are counted per service for 7 days and shown to the
 * creator only (signed settings read), never on a public endpoint.
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
    verify: vi.fn(async () => ({ isValid: true, payer: '0xAbCdEf0000000000000000000000000000000009' })),
    settle: vi.fn(async () => ({ success: true, transaction: '0x' + 'e'.repeat(64), network: 'eip155:143', payer: '0x' + '1'.repeat(40) })),
  };
});
vi.mock('../db/client.js', () => ({ get db() { return h.db; } }));
vi.mock('../env.js', () => ({
  RPC_URL: 'http://127.0.0.1:1', CHAIN_ID: 143, SUBMITTERS: [], REGISTRY_ADDR: '0x0000000000000000000000000000000000000001',
  ESCROW_ADDR: '0x0000000000000000000000000000000000000002', VAULT_ADDR: '0x0000000000000000000000000000000000000003',
  USDC_ADDR: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', PAYMENT_TIMEOUT_S: 60, FACILITATOR_URL: 'http://facilitator.invalid',
}));
vi.mock('@x402/core/http', async (orig) => ({
  ...(await orig<typeof import('@x402/core/http')>()),
  HTTPFacilitatorClient: class { verify = h.verify; settle = h.settle; },
}));

const { services, idxRegistrations, schemaMismatches } = await import('../db/schema.js');
const { eq } = await import('drizzle-orm');
const { upsertTokenFromRegistration } = await import('../services/tokenSync.js');
const { adminListAsset } = await import('../services/launchFee.js');
const shared = await import('@astralaunch/shared');
const { privateKeyToAccount } = await import('viem/accounts');
const { encodePaymentSignatureHeader } = await import('@x402/core/http');
const servicesRouter = (await import('../routes/services.js')).default;
const tokensRouter = (await import('../routes/tokens.js')).default;
const creatorRouter = (await import('../routes/creator.js')).default;
const gateway = (await import('../routes/gateway.js')).default;

// Anvil dev keys, tests only.
const creator = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const stranger = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const ASSET = '0x' + 'c'.repeat(40);

const app = new Hono();
app.route('/api/services', servicesRouter);
app.route('/api/tokens', tokensRouter);
app.route('/api/creator', creatorRouter);
app.route('/s', gateway);
const send = (path: string, body: unknown, method = 'POST') => app.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const paid = (path: string) => app.request(path, { headers: { 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader({
  x402Version: 2, resource: { url: 'http://x' }, accepted: { scheme: 'exact', network: 'eip155:143' },
  payload: { signature: '0x00', authorization: { from: '0xAbCdEf0000000000000000000000000000000009', to: '0x' + '5'.repeat(40), value: '10000' } },
} as never) } });
let clock = Math.floor(Date.now() / 1000);
const next = () => ++clock;

// The stored schema pins "source" to one value; the upstream now also answers "fallback sample" (the nullfeed case).
const schemaWith = (sources: string[]) => JSON.stringify({
  type: 'object', required: ['source', 'papers'],
  properties: { source: { enum: sources }, papers: { type: 'array' } },
});
const OLD_SCHEMA = schemaWith(['arXiv API (export.arxiv.org)']);
const NEW_SCHEMA = schemaWith(['arXiv API (export.arxiv.org)', 'fallback sample']);
const FALLBACK = { source: 'fallback sample', papers: [] };

type Settings = { responseSchema: string | null; schemaMismatches: { count7d: number; latest: { path: string | null; code: string; detail: string | null; at: string } | null } };

describe('response schema: signed update / remove, mismatches for the creator only', () => {
  let db: TestDb; let close: () => Promise<void>;
  let up: Awaited<ReturnType<typeof startTestUpstream>>;
  let id = '';

  const settings = async (signer = creator) => {
    const issuedAt = next();
    return send(`/api/services/${id}/settings`, { issuedAt, signature: await signer.signMessage({ message: shared.serviceSettingsMessage(id, ASSET, issuedAt) }) });
  };
  const update = async (fields: Record<string, unknown>, signer = creator) => {
    const m = { ...fields, issuedAt: next() };
    return send(`/api/services/${id}`, { ...m, signature: await signer.signMessage({ message: shared.serviceUpdateMessage(id, ASSET, m) }) }, 'PATCH');
  };

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    h.db = db;
    up = await startTestUpstream(json(FALLBACK));
    const reg = {
      chainId: 143, txHash: '0x' + '3'.repeat(64), logIndex: 0, asset: ASSET, creator: creator.address.toLowerCase(), router: '0x' + '5'.repeat(40),
      poolId: '0x00', numeraire: '', initializer: '', launcher: '0x' + '9'.repeat(40), blockNumber: 10n, timestamp: 1_800_000_000n,
    };
    await db.insert(idxRegistrations).values(reg);
    await upsertTokenFromRegistration(db, reg, { name: 'Feed', symbol: 'FEED', decimals: 18 });
    await adminListAsset(db, ASSET, 143, 'test');
    const [row] = await db.insert(services).values({
      slug: 'feedy', name: 'feedy', asset: ASSET, router: '0x' + '5'.repeat(40), creator: creator.address.toLowerCase(),
      upstreamUrl: `${up.url}/feed`, priceUsdc: '10000', upstreamSecret: 's', responseSchema: OLD_SCHEMA,
    }).returning();
    id = row!.id;
  });
  afterAll(async () => { await up.close(); await close(); });
  beforeEach(() => { h.settle.mockClear(); up.reset(); });

  it('shared: responseSchema is a signed update field ("" removes); messages without it are unchanged', () => {
    const base = { priceUsdc: '1', issuedAt: 1 };
    expect(shared.serviceUpdateMessage('id-1', ASSET, base)).toBe(`Astralaunch: update service\n{"serviceId":"id-1","asset":"${ASSET}","priceUsdc":"1","issuedAt":1}`);
    expect(shared.serviceUpdateMessage('id-1', ASSET, { ...base, responseSchema: '{"type":"object"}' }))
      .toBe(`Astralaunch: update service\n{"serviceId":"id-1","asset":"${ASSET}","priceUsdc":"1","responseSchema":"{\\"type\\":\\"object\\"}","issuedAt":1}`);
    expect(shared.updateServiceSchema.safeParse({ responseSchema: '', issuedAt: 1, signature: '0x00' }).success).toBe(true);
    expect(shared.updateServiceSchema.safeParse({ responseSchema: 'x'.repeat(20_001), issuedAt: 1, signature: '0x00' }).success).toBe(false);
  });

  it('mismatch counting: each failed check is recorded (path without query), 7-day window, not charged', async () => {
    for (const q of ['?topic=private%20stuff', '', '?topic=x']) {
      const res = await paid(`/s/feedy/digest${q}`);
      expect(res.status).toBe(502);
    }
    expect(h.settle).not.toHaveBeenCalled();
    // An old one (8 days) is outside the window.
    await db.insert(schemaMismatches).values({ serviceId: id, code: 'schema_mismatch', detail: 'old', path: '/old', createdAt: new Date(Date.now() - 8 * 86_400_000) });

    const res = await settings();
    expect(res.status).toBe(200);
    const s = await res.json() as Settings;
    expect(s.responseSchema).toBe(OLD_SCHEMA);
    expect(s.schemaMismatches.count7d).toBe(3);
    expect(s.schemaMismatches.latest).toMatchObject({ path: '/digest', code: 'schema_mismatch' });
    expect(s.schemaMismatches.latest!.detail).toMatch(/source/);
    const rows = await db.select().from(schemaMismatches).where(eq(schemaMismatches.serviceId, id));
    expect(rows.every((r) => !r.path?.includes('?') && !r.path?.includes('private'))).toBe(true);

    // Writing a new mismatch prunes rows older than 7 days.
    await paid('/s/feedy/digest');
    expect((await db.select().from(schemaMismatches).where(eq(schemaMismatches.serviceId, id))).map((r) => r.path)).not.toContain('/old');
  });

  it('creator-only: another wallet cannot read them; no public endpoint shows them', async () => {
    const bad = await settings(stranger);
    expect(bad.status).toBe(403);
    expect(await bad.text()).not.toContain('schemaMismatches');
    for (const path of [`/api/tokens/${ASSET}`, '/api/tokens?filter=all', '/api/services/feedy/manifest', `/api/creator/${creator.address}`]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      const text = await res.text();
      for (const f of ['schemaMismatches', 'count7d', 'Instance', OLD_SCHEMA]) expect(text.includes(f), `${path} shows ${f.slice(0, 20)}`).toBe(false);
    }
  }, 120_000);   // detail/creator also try on-chain reads against the test RPC (refused, retried)

  it('update schema: invalid refused (400), a stranger refused (403); signed update stores it, clears old mismatches, calls settle again', async () => {
    const invalid = await update({ responseSchema: '{not json' });
    expect(invalid.status).toBe(400);
    expect((await invalid.json() as { error: string }).error).toMatch(/not valid JSON/);
    expect((await update({ responseSchema: '[1]' })).status).toBe(400);
    expect((await update({ responseSchema: NEW_SCHEMA }, stranger)).status).toBe(403);

    const ok = await update({ responseSchema: NEW_SCHEMA });
    expect(ok.status).toBe(200);
    expect(await ok.text()).not.toContain('responseSchema');   // the PATCH answer stays public-shaped
    expect((await db.query.services.findFirst({ where: eq(services.id, id) }))!.responseSchema).toBe(NEW_SCHEMA);
    expect((await (await settings()).json() as Settings).schemaMismatches).toEqual({ count7d: 0, latest: null });

    const res = await paid('/s/feedy/digest?topic=agent%20payments');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(FALLBACK);
    expect(h.settle).toHaveBeenCalledOnce();
  });

  it('remove schema: responseSchema "" → stored null, responses are no longer checked', async () => {
    const res = await update({ responseSchema: '' });
    expect(res.status).toBe(200);
    expect((await db.query.services.findFirst({ where: eq(services.id, id) }))!.responseSchema).toBeNull();
    expect((await (await settings()).json() as Settings).responseSchema).toBeNull();

    up.set((_q, r) => { r.writeHead(200, { 'content-type': 'text/plain' }); r.end('not json at all'); });
    const call = await paid('/s/feedy/digest');
    expect(call.status).toBe(200);
    expect(await call.text()).toBe('not json at all');   // read it: the gateway logs the call when the body ends
    expect(h.settle).toHaveBeenCalledOnce();
    expect((await (await settings()).json() as Settings).schemaMismatches.count7d).toBe(0);
  });
});

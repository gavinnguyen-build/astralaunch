/**
 * Optional service examplePath (migration 0011): signed in the create / update / launch-details messages,
 * validated, stored, exposed in the manifest. Messages without it are byte-for-byte the pre-0011 ones,
 * so earlier signatures stay valid.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { createTestDb, type TestDb } from './helpers/pgliteDb.js';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../db/client.js', () => ({ get db() { return h.db; } }));
vi.mock('../env.js', () => ({ USDC_ADDR: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', PAYMENT_TIMEOUT_S: 60 }));
vi.mock('../lib/ssrf.js', () => ({ assertSafeUpstream: vi.fn(async () => {}), SsrfError: class extends Error {} }));

const { services, idxRegistrations } = await import('../db/schema.js');
const { upsertTokenFromRegistration } = await import('../services/tokenSync.js');
const { adminListAsset } = await import('../services/launchFee.js');
const { applyLaunchDetails } = await import('../services/creatorWrites.js');
const { serviceCreateMessage, serviceUpdateMessage, launchDetailsMessage, examplePathError } = await import('@astralaunch/shared');
const { privateKeyToAccount } = await import('viem/accounts');
const { eq } = await import('drizzle-orm');
const servicesRouter = (await import('../routes/services.js')).default;

// Anvil dev key, tests only (never used on mainnet).
const creator = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const LISTED = '0x' + 'a'.repeat(40);
const app = new Hono();
app.route('/api/services', servicesRouter);
const now = () => Math.floor(Date.now() / 1000);
const send = (method: 'POST' | 'PATCH', path: string, body: unknown) =>
  app.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const create = (over: Record<string, unknown> = {}) => ({
  asset: LISTED, slug: 'sight', name: 'Sight', upstreamUrl: 'https://api.example.com/sight', priceUsdc: '500000', issuedAt: now(), ...over,
});
const signCreate = async (m: ReturnType<typeof create>) => ({ ...m, signature: await creator.signMessage({ message: serviceCreateMessage(m as never) }) });

describe('signed messages stay compatible', () => {
  const asset = '0x30Ae380593A04C14aBFa994969B718a78A6105aD';
  const svc = { slug: 'nullsight', name: 'Null Sight', upstreamUrl: 'http://127.0.0.1:4001/sight', priceUsdc: '500000', description: 'd' };
  it('without examplePath: identical to the pre-0011 strings (captured before the change)', () => {
    expect(serviceCreateMessage({ asset, ...svc, issuedAt: 1790000000 } as never)).toBe('Astralaunch: register service\n{"asset":"0x30ae380593a04c14abfa994969b718a78a6105ad","slug":"nullsight","name":"Null Sight","upstreamUrl":"http://127.0.0.1:4001/sight","priceUsdc":"500000","description":"d","issuedAt":1790000000}');
    expect(serviceUpdateMessage('11111111-1111-4111-8111-111111111111', asset, { upstreamUrl: 'http://127.0.0.1:4001/sight', issuedAt: 1790000000 } as never)).toBe('Astralaunch: update service\n{"serviceId":"11111111-1111-4111-8111-111111111111","asset":"0x30ae380593a04c14abfa994969b718a78a6105ad","upstreamUrl":"http://127.0.0.1:4001/sight","issuedAt":1790000000}');
    expect(launchDetailsMessage({ asset, description: 'x', service: svc, issuedAt: 1790000000 } as never)).toBe('Astralaunch: launch details\n{"asset":"0x30ae380593a04c14abfa994969b718a78a6105ad","description":"x","service":{"slug":"nullsight","name":"Null Sight","upstreamUrl":"http://127.0.0.1:4001/sight","priceUsdc":"500000","description":"d"},"issuedAt":1790000000}');
  });
  it('with examplePath: the field is signed (before issuedAt / at the end of the service)', () => {
    expect(serviceCreateMessage({ asset, ...svc, examplePath: '/signals?handle=monad', issuedAt: 1 } as never)).toContain('"description":"d","examplePath":"/signals?handle=monad","issuedAt":1}');
    expect(serviceUpdateMessage('id', asset, { examplePath: '/digest?topic=agent%20payments', issuedAt: 1 } as never)).toContain('"examplePath":"/digest?topic=agent%20payments","issuedAt":1}');
    expect(launchDetailsMessage({ asset, service: { ...svc, examplePath: '/signals' }, issuedAt: 1 } as never)).toContain('"description":"d","examplePath":"/signals"}');
  });
  it('examplePathError', () => {
    for (const ok of ['/signals?handle=monad', '/digest?topic=agent%20payments', '/', '/a/b.json']) expect(examplePathError(ok), ok).toBeNull();
    for (const bad of ['signals', '//evil.example/x', '/a b', '/x#y', '/a\\b', '/a%2Fb', '/../feed', '/%2e%2e/feed', '/a/./b', '/%zz']) expect(examplePathError(bad), bad).not.toBeNull();
  });
});

describe('services API with examplePath', () => {
  let db: TestDb; let close: () => Promise<void>;
  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    h.db = db;
    const reg = {
      chainId: 143, txHash: '0x' + '1'.repeat(64), logIndex: 0, asset: LISTED, creator: creator.address.toLowerCase(),
      router: '0x' + '5'.repeat(40), poolId: '0x00', numeraire: '', initializer: '', launcher: '0x' + '9'.repeat(40),
      blockNumber: 10n, timestamp: 1_800_000_000n,
    };
    await db.insert(idxRegistrations).values(reg);
    await upsertTokenFromRegistration(db, reg, { name: 'T', symbol: 'T', decimals: 18 });
    await adminListAsset(db, LISTED, 143, 'test');
  });
  afterEach(async () => { await close(); });
  const row = async () => (await db.select().from(services).where(eq(services.slug, 'sight')))[0]!;

  it('create stores it and the manifest exposes it; a legacy create (no examplePath) still works', async () => {
    const res = await send('POST', '/api/services', await signCreate(create({ examplePath: '/signals?handle=monad' })));
    expect(res.status).toBe(201);
    expect((await row()).examplePath).toBe('/signals?handle=monad');
    const man = await (await app.request('/api/services/sight/manifest')).json() as { examplePath: string; endpoint: string };
    expect(man).toMatchObject({ examplePath: '/signals?handle=monad', endpoint: '/s/sight' });
    const legacy = await send('POST', '/api/services', await signCreate(create({ slug: 'legacy' })));
    expect(legacy.status).toBe(201);
    expect((await (await app.request('/api/services/legacy/manifest')).json() as { examplePath: unknown }).examplePath).toBeNull();
  });

  it('examplePath is covered by the signature (added after signing → rejected)', async () => {
    const signed = await signCreate(create());
    const res = await send('POST', '/api/services', { ...signed, examplePath: '/signals' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await db.select().from(services)).toHaveLength(0);
  });

  it('invalid examplePath → 400 before any write', async () => {
    for (const p of ['signals', '/../feed', '/a%2Fb', '//evil.example']) {
      const res = await send('POST', '/api/services', await signCreate(create({ examplePath: p })));
      expect(res.status, p).toBe(400);
    }
    expect(await db.select().from(services)).toHaveLength(0);
  });

  it('signed update sets it and "" removes it', async () => {
    const { id } = await (await send('POST', '/api/services', await signCreate(create()))).json() as { id: string };
    const upd = async (examplePath: string, issuedAt: number) => {
      const m = { examplePath, issuedAt };
      return send('PATCH', `/api/services/${id}`, { ...m, signature: await creator.signMessage({ message: serviceUpdateMessage(id, LISTED, m) }) });
    };
    const t = now();
    const r1 = await upd('/digest?topic=agent%20payments', t + 1);
    expect(r1.status).toBe(200);
    expect((await r1.json() as { examplePath: string }).examplePath).toBe('/digest?topic=agent%20payments');
    expect((await upd('', t + 2)).status).toBe(200);
    expect((await row()).examplePath).toBeNull();
  });

  it('launch-details stores service.examplePath', async () => {
    const m = { asset: LISTED, service: { slug: 'sight', name: 'Sight', upstreamUrl: 'https://api.example.com/sight', priceUsdc: '500000', examplePath: '/signals?handle=monad' }, issuedAt: now() };
    const res = await applyLaunchDetails(db as never, { ...m, signature: await creator.signMessage({ message: launchDetailsMessage(m) }) } as never, now());
    expect(res.service?.slug).toBe('sight');
    expect((await row()).examplePath).toBe('/signals?handle=monad');
  });
});

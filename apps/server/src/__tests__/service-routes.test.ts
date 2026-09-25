/**
 * POST/PATCH /api/services only accept requests signed by the token's ON-CHAIN
 * creator (tokens row written by the indexer), with replay protection (D-SV1).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { createTestDb, type TestDb } from './helpers/pgliteDb.js';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../db/client.js', () => ({ get db() { return h.db; } }));
vi.mock('../env.js', () => ({
  USDC_ADDR: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', PAYMENT_TIMEOUT_S: 60,
}));
// Upstream DNS/SSRF resolution is covered elsewhere; no network in unit tests.
vi.mock('../lib/ssrf.js', () => ({ assertSafeUpstream: vi.fn(async () => {}), SsrfError: class extends Error {} }));

const { services, idxRegistrations } = await import('../db/schema.js');
const { upsertTokenFromRegistration } = await import('../services/tokenSync.js');
const { adminListAsset } = await import('../services/launchFee.js');
const { serviceCreateMessage, serviceUpdateMessage } = await import('@astralaunch/shared');
const { privateKeyToAccount } = await import('viem/accounts');
const { eq } = await import('drizzle-orm');
const servicesRouter = (await import('../routes/services.js')).default;

// Anvil dev keys, tests only (never used on mainnet).
const creator  = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const attacker = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

const LISTED   = '0x' + 'a'.repeat(40);
const UNLISTED = '0x' + 'b'.repeat(40);
const UNKNOWN  = '0x' + 'c'.repeat(40);
const ROUTER   = '0x' + '5'.repeat(40);

const app = new Hono();
app.route('/api/services', servicesRouter);

const now = () => Math.floor(Date.now() / 1000);
const send = (method: 'POST' | 'PATCH', path: string, body: unknown) => app.request(path, {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

type Signer = typeof creator;
const baseCreate = (asset = LISTED, over: Record<string, unknown> = {}) => ({
  asset, slug: 'svc-one', name: 'Service one', upstreamUrl: 'https://api.example.com', priceUsdc: '1000',
  description: 'does things', issuedAt: now(), ...over,
});
async function signedCreate(signer: Signer, m: ReturnType<typeof baseCreate>) {
  return { ...m, signature: await signer.signMessage({ message: serviceCreateMessage(m) }) };
}
async function signedUpdate(signer: Signer, id: string, asset: string, m: { priceUsdc?: string; upstreamUrl?: string; issuedAt: number }) {
  return { ...m, signature: await signer.signMessage({ message: serviceUpdateMessage(id, asset, m) }) };
}

describe('service create/update auth', () => {
  let db: TestDb; let close: () => Promise<void>;

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    h.db = db;
    for (const [i, asset] of [LISTED, UNLISTED].entries()) {
      const reg = {
        chainId: 143, txHash: '0x' + String(i + 1).repeat(64), logIndex: 0, asset, creator: creator.address.toLowerCase(),
        router: ROUTER, poolId: '0x00', numeraire: '', initializer: '', launcher: '0x' + '9'.repeat(40),
        blockNumber: 10n + BigInt(i), timestamp: 1_800_000_000n,
      };
      await db.insert(idxRegistrations).values(reg);
      await upsertTokenFromRegistration(db, reg, { name: 'T', symbol: 'T', decimals: 18 });
    }
    await adminListAsset(db, LISTED, 143, 'test');
  });
  afterEach(async () => { await close(); });

  const createAsCreator = async () => {
    const res = await send('POST', '/api/services', await signedCreate(creator, baseCreate()));
    expect(res.status).toBe(201);
    return (await res.json() as { id: string }).id;
  };

  it('creator succeeds: create uses on-chain creator + router, then update', async () => {
    const res = await send('POST', '/api/services',
      { ...(await signedCreate(creator, baseCreate())), creator: attacker.address, router: '0x' + '6'.repeat(40) });
    expect(res.status).toBe(201);
    const { id, router } = await res.json() as { id: string; router: string };
    expect(router).toBe(ROUTER);
    const [row] = await db.select().from(services).where(eq(services.id, id));
    expect(row).toMatchObject({ creator: creator.address.toLowerCase(), router: ROUTER, priceUsdc: '1000' });

    const upd = await send('PATCH', `/api/services/${id}`, await signedUpdate(creator, id, LISTED, { priceUsdc: '2500', issuedAt: now() + 1 }));
    expect(upd.status).toBe(200);
    const body = await upd.json() as Record<string, unknown>;
    expect(body.priceUsdc).toBe('2500');
    expect(body).not.toHaveProperty('upstreamSecret');
  });

  it('non-creator cannot create (even claiming to be the creator)', async () => {
    const res = await send('POST', '/api/services', { ...(await signedCreate(attacker, baseCreate())), creator: creator.address });
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toMatch(/on-chain creator/);
    expect(await db.select().from(services)).toHaveLength(0);
  });

  it('non-creator cannot overwrite an existing service', async () => {
    const id = await createAsCreator();
    const patch = await send('PATCH', `/api/services/${id}`,
      await signedUpdate(attacker, id, LISTED, { upstreamUrl: 'https://evil.example.com', priceUsdc: '1', issuedAt: now() + 1 }));
    expect(patch.status).toBe(403);
    // Re-registering the same slug as the attacker is rejected on auth, before the slug check.
    const dup = await send('POST', '/api/services', await signedCreate(attacker, baseCreate(LISTED, { upstreamUrl: 'https://evil.example.com' })));
    expect(dup.status).toBe(403);
    const [row] = await db.select().from(services).where(eq(services.id, id));
    expect(row).toMatchObject({ upstreamUrl: 'https://api.example.com', priceUsdc: '1000' });
  });

  it('replay rejected: same signed create or update twice, and stale/older issuedAt', async () => {
    const create = await signedCreate(creator, baseCreate());
    expect((await send('POST', '/api/services', create)).status).toBe(201);
    const replay = await send('POST', '/api/services', create);
    expect(replay.status).toBe(409);
    expect((await replay.json() as { error: string }).error).toMatch(/replay/);
    const [{ id }] = await db.select({ id: services.id }).from(services);

    const upd = await signedUpdate(creator, id!, LISTED, { priceUsdc: '2000', issuedAt: now() + 2 });
    expect((await send('PATCH', `/api/services/${id}`, upd)).status).toBe(200);
    expect((await send('PATCH', `/api/services/${id}`, upd)).status).toBe(409);

    // An older (but still fresh) signed update cannot be applied after a newer one.
    const older = await signedUpdate(creator, id!, LISTED, { priceUsdc: '1', issuedAt: now() + 1 });
    expect((await send('PATCH', `/api/services/${id}`, older)).status).toBe(409);
    // Outside the freshness window.
    const stale = await signedCreate(creator, baseCreate(LISTED, { slug: 'svc-two', issuedAt: now() - 3600 }));
    expect((await send('POST', '/api/services', stale)).status).toBe(400);

    const [row] = await db.select().from(services).where(eq(services.id, id!));
    expect(row!.priceUsdc).toBe('2000');
  });

  it('404 if the token is not registered, 403 if not listed', async () => {
    expect((await send('POST', '/api/services', await signedCreate(creator, baseCreate(UNKNOWN)))).status).toBe(404);
    const unlisted = await send('POST', '/api/services', await signedCreate(creator, baseCreate(UNLISTED)));
    expect(unlisted.status).toBe(403);
    expect((await unlisted.json() as { error: string }).error).toMatch(/not listed/);
    expect((await send('PATCH', '/api/services/not-a-uuid', { priceUsdc: '1', issuedAt: now(), signature: '0x00' })).status).toBe(404);
  });
});

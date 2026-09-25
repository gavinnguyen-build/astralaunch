/**
 * POST /api/tokens/launch-details: metadata + service under ONE creator signature
 * (launchDetailsMessage). Same rules as the two single-purpose endpoints, all-or-nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { createTestDb, type TestDb } from './helpers/pgliteDb.js';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../db/client.js', () => ({ get db() { return h.db; } }));
vi.mock('../env.js', () => ({
  RPC_URL: 'http://127.0.0.1:8545', CHAIN_ID: 143, REGISTRY_ADDR: '0x0000000000000000000000000000000000000001', SUBMITTERS: [],
  USDC_ADDR: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', PAYMENT_TIMEOUT_S: 60,
}));
vi.mock('../lib/ssrf.js', () => ({ assertSafeUpstream: vi.fn(async () => {}), SsrfError: class extends Error {} }));

const { services, tokens, idxRegistrations } = await import('../db/schema.js');
const { upsertTokenFromRegistration } = await import('../services/tokenSync.js');
const { adminListAsset } = await import('../services/launchFee.js');
const { launchDetailsMessage, tokenMetadataMessage, serviceCreateMessage } = await import('@astralaunch/shared');
const { privateKeyToAccount } = await import('viem/accounts');
const { eq } = await import('drizzle-orm');
const tokensRouter = (await import('../routes/tokens.js')).default;
const servicesRouter = (await import('../routes/services.js')).default;

// Anvil dev keys, tests only.
const creator  = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const attacker = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

const LISTED   = '0x' + 'a'.repeat(40);
const UNLISTED = '0x' + 'b'.repeat(40);
const ROUTER   = '0x' + '5'.repeat(40);

const app = new Hono();
app.route('/api/tokens', tokensRouter);
app.route('/api/services', servicesRouter);
const post = (path: string, body: unknown) => app.request(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const now = () => Math.floor(Date.now() / 1000);

const svc = { slug: 'one-sig', name: 'One sig', upstreamUrl: 'https://api.example.com', priceUsdc: '500000', description: 'x' };
const details = (over: Record<string, unknown> = {}) => ({
  asset: LISTED, xHandle: '@onesig', website: 'https://example.com', description: 'Token', service: svc, issuedAt: now(), ...over,
});
async function signed(signer: typeof creator, m: ReturnType<typeof details>) {
  return { ...m, signature: await signer.signMessage({ message: launchDetailsMessage(m as never) }) };
}

describe('POST /api/tokens/launch-details', () => {
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

  it('one signature saves metadata and registers the service together', async () => {
    const res = await post('/api/tokens/launch-details', await signed(creator, details()));
    expect(res.status).toBe(201);
    const body = await res.json() as { metadataUpdated: boolean; service: { slug: string; router: string } };
    expect(body).toMatchObject({ metadataUpdated: true, service: { slug: 'one-sig', router: ROUTER } });
    const [tok] = await db.select().from(tokens).where(eq(tokens.asset, LISTED));
    expect(tok).toMatchObject({ xHandle: 'onesig', website: 'https://example.com', description: 'Token' });
    const [s] = await db.select().from(services).where(eq(services.slug, 'one-sig'));
    expect(s).toMatchObject({ asset: LISTED, router: ROUTER, creator: creator.address.toLowerCase(), priceUsdc: '500000' });
  });

  it('metadata only (no service) returns 200 and works for an unlisted token', async () => {
    const m = details({ asset: UNLISTED, service: undefined });
    const res = await post('/api/tokens/launch-details', await signed(creator, m));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ metadataUpdated: true, service: null });
  });

  it('a service needs a listed token; nothing is written when it is refused', async () => {
    const res = await post('/api/tokens/launch-details', await signed(creator, details({ asset: UNLISTED })));
    expect(res.status).toBe(403);
    const [tok] = await db.select().from(tokens).where(eq(tokens.asset, UNLISTED));
    expect(tok!.xHandle).toBeNull();
  });

  it('rejects a signature that is not the on-chain creator', async () => {
    expect((await post('/api/tokens/launch-details', await signed(attacker, details()))).status).toBe(403);
  });

  it('rejects any field changed after signing (e.g. the service price)', async () => {
    const s = await signed(creator, details());
    const tampered = { ...s, service: { ...svc, priceUsdc: '1' } };
    expect((await post('/api/tokens/launch-details', tampered)).status).toBe(403);
  });

  it('rejects a replay of the same signed request', async () => {
    const s = await signed(creator, details({ service: undefined }));
    expect((await post('/api/tokens/launch-details', s)).status).toBe(200);
    expect((await post('/api/tokens/launch-details', s)).status).toBe(409);
  });

  it('a taken slug rolls back the metadata too (all-or-nothing)', async () => {
    const first = await signed(creator, details({ xHandle: 'first', issuedAt: now() - 5 }));
    expect((await post('/api/tokens/launch-details', first)).status).toBe(201);
    const second = await signed(creator, details({ xHandle: 'second' }));
    expect((await post('/api/tokens/launch-details', second)).status).toBe(409);
    const [tok] = await db.select().from(tokens).where(eq(tokens.asset, LISTED));
    expect(tok!.xHandle).toBe('first');
  });

  it('rejects a stale issuedAt and an invalid upstream', async () => {
    expect((await post('/api/tokens/launch-details', await signed(creator, details({ issuedAt: now() - 3600 })))).status).toBe(400);
    const bad = await signed(creator, details({ service: { ...svc, upstreamUrl: 'https://api.example.com/?x=1' } }));
    expect((await post('/api/tokens/launch-details', bad)).status).toBe(400);
  });

  it('requires metadata or a service', async () => {
    const res = await post('/api/tokens/launch-details', await signed(creator, { asset: LISTED, issuedAt: now() } as never));
    expect(res.status).toBe(400);
  });

  it('the combined message is distinct from the single-purpose messages (no cross-use)', async () => {
    const m = details({ service: undefined, xHandle: undefined, website: undefined });
    const metaSig = await creator.signMessage({ message: tokenMetadataMessage({ asset: LISTED, description: 'Token', issuedAt: m.issuedAt as number }) });
    expect((await post('/api/tokens/launch-details', { ...m, signature: metaSig })).status).toBe(403);
    const svcMsg = serviceCreateMessage({ asset: LISTED, ...svc, issuedAt: now() });
    expect(launchDetailsMessage(details() as never)).not.toBe(svcMsg);
  });

  it('old single-purpose endpoints still accept their own messages', async () => {
    const meta = { asset: LISTED, description: 'Old flow', issuedAt: now() };
    const r1 = await post('/api/tokens', { ...meta, signature: await creator.signMessage({ message: tokenMetadataMessage(meta) }) });
    expect(r1.status).toBe(200);
    const sm = { asset: LISTED, ...svc, slug: 'old-flow', issuedAt: now() };
    const r2 = await post('/api/services', { ...sm, signature: await creator.signMessage({ message: serviceCreateMessage(sm) }) });
    expect(r2.status).toBe(201);
  });
});

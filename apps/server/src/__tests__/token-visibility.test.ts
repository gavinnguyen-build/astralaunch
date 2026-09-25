/**
 * Public endpoints only expose tokens whose launch fee was paid and consumed;
 * unlisted tokens are reachable only through the admin endpoint (D-LF4).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Hono } from 'hono';
import { createTestDb, type TestDb } from './helpers/pgliteDb.js';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../db/client.js', () => ({ get db() { return h.db; } }));
vi.mock('../env.js', () => ({
  RPC_URL: 'http://127.0.0.1:1', CHAIN_ID: 143, SUBMITTERS: [],
  REGISTRY_ADDR: '0x0000000000000000000000000000000000000001',
  ESCROW_ADDR:   '0x0000000000000000000000000000000000000002',
  VAULT_ADDR:    '0x0000000000000000000000000000000000000003',
  ADMIN_API_KEY: 'test-admin-key',
  USDC_ADDR: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', PAYMENT_TIMEOUT_S: 60, HMAC_MASTER_KEY: 'k',
}));

const { tokens, services, idxRegistrations } = await import('../db/schema.js');
const { consumeForRegistration, verifyLaunchFee } = await import('../services/launchFee.js');
const { upsertTokenFromRegistration } = await import('../services/tokenSync.js');
const { LAUNCH_FEE_TREASURY, LAUNCH_FEE_WEI, tokenMetadataMessage, serviceCreateMessage } = await import('@astralaunch/shared');
const { privateKeyToAccount } = await import('viem/accounts');
const { eq } = await import('drizzle-orm');
const servicesRouter = (await import('../routes/services.js')).default;
const tokensRouter   = (await import('../routes/tokens.js')).default;
const explorerRouter = (await import('../routes/explorer.js')).default;
const adminRouter    = (await import('../routes/admin.js')).default;

// Anvil dev keys, tests only (never used on mainnet).
const creatorAcct = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const otherAcct   = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const LAUNCHER = '0x1111111111111111111111111111111111111111';
const CREATOR  = creatorAcct.address.toLowerCase();
const PAID     = '0x' + 'a'.repeat(40);  // fee paid by LAUNCHER, creator = CREATOR
const UNPAID   = '0x' + 'b'.repeat(40);  // registered on-chain, no fee
const FEE_TX   = '0x' + '1'.repeat(64);

describe('token visibility', () => {
  let db: TestDb; let close: () => Promise<void>;
  const app = new Hono();
  app.route('/api/tokens', tokensRouter);
  app.route('/api/explorer', explorerRouter);
  app.route('/api/admin', adminRouter);
  app.route('/api/services', servicesRouter);

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    h.db = db;

    await verifyLaunchFee(db, {
      getTx: async () => ({ from: LAUNCHER, to: LAUNCH_FEE_TREASURY, value: LAUNCH_FEE_WEI, blockNumber: 10n }),
      getReceipt: async () => ({ status: 'success', blockNumber: 10n }),
      getFinalizedBlockNumber: async () => 100n,
      getBlockTimestamp: async () => 1_800_000_000n,
    }, FEE_TX, { chainId: 143, nowS: 1_800_000_000n });

    for (const [i, a] of [PAID, UNPAID].entries()) {
      const reg = {
        chainId: 143, txHash: '0x' + String(i + 2).repeat(64), logIndex: 0, asset: a, creator: CREATOR,
        router: '0x' + String(i + 5).repeat(40), poolId: '0x00', numeraire: '', initializer: '',
        launcher: LAUNCHER, blockNumber: 20n + BigInt(i), timestamp: 1_800_000_000n,
      };
      // Same path as the indexer on a Registered event: no POST /api/tokens involved.
      await db.transaction(async (tx) => {
        await tx.insert(idxRegistrations).values(reg);
        await upsertTokenFromRegistration(tx, reg, { name: `T${i}`, symbol: `T${i}`, decimals: 18 });
        await consumeForRegistration(tx, reg);
      });
      await db.insert(services).values({
        slug: `svc-${i}`, name: `svc ${i}`, asset: a, router: reg.router, creator: CREATOR,
        upstreamUrl: 'https://example.com', priceUsdc: '1000', upstreamSecret: 's',
      });
    }
  });
  afterAll(async () => { await close(); });

  it('GET /api/tokens lists the fee-paid token (creator ≠ launcher) and hides the unpaid one', async () => {
    const res = await app.request('/api/tokens?sort=new');
    expect(res.status).toBe(200);
    const body = await res.json() as { tokens: { asset: string; creator: string }[] };
    expect(body.tokens.map(t => t.asset)).toEqual([PAID]);
    expect(body.tokens[0]!.creator).toBe(CREATOR);
  });

  it('token detail + sub-resources 404 for the unpaid token', async () => {
    for (const path of ['', '/metrics', '/payments', '/buybacks', '/health']) {
      expect((await app.request(`/api/tokens/${UNPAID}${path}`)).status).toBe(404);
    }
    expect((await app.request(`/api/tokens/${PAID}/buybacks`)).status).toBe(200);
  });

  it('explorer hides services of unlisted tokens', async () => {
    const body = await (await app.request('/api/explorer')).json() as { services: { asset: string }[] };
    expect(body.services.map(s => s.asset)).toEqual([PAID]);
  });

  it('admin endpoint exposes the unlisted token, and requires the key', async () => {
    expect((await app.request('/api/admin/tokens/unlisted')).status).toBe(401);
    expect((await app.request('/api/admin/tokens/unlisted', { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
    const res = await app.request('/api/admin/tokens/unlisted', { headers: { Authorization: 'Bearer test-admin-key' } });
    expect(res.status).toBe(200);
    const body = await res.json() as { tokens: { asset: string; launcher: string; creator: string }[] };
    expect(body.tokens).toHaveLength(1);
    expect(body.tokens[0]).toMatchObject({ asset: UNPAID, launcher: LAUNCHER, creator: CREATOR });
  });

  it('unlisted token still hidden even though the indexer created its tokens row', async () => {
    expect(await db.select().from(tokens).where(eq(tokens.asset, UNPAID))).toHaveLength(1);
    const body = await (await app.request('/api/tokens')).json() as { tokens: { asset: string }[] };
    expect(body.tokens.map(t => t.asset)).not.toContain(UNPAID);
  });

  const post = (path: string, body: unknown) => app.request(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const now = () => Math.floor(Date.now() / 1000);

  it('POST /api/tokens cannot create a token that is not registered on-chain', async () => {
    const asset = '0x' + 'c'.repeat(40);
    const m = { asset, description: 'fake', issuedAt: now() };
    const res = await post('/api/tokens', { ...m, signature: await creatorAcct.signMessage({ message: tokenMetadataMessage(m) }) });
    expect(res.status).toBe(404);
    expect(await db.select().from(tokens).where(eq(tokens.asset, asset))).toHaveLength(0);
  });

  it('POST /api/tokens updates metadata only, signed by the on-chain creator', async () => {
    const m = { asset: PAID, imageUrl: 'https://img.example/a.png', xHandle: '@nullsight', website: 'https://a.example', description: 'hi', issuedAt: now() };
    const msg = tokenMetadataMessage(m);

    const wrong = await post('/api/tokens', { ...m, signature: await otherAcct.signMessage({ message: msg }) });
    expect(wrong.status).toBe(401);
    const tampered = await post('/api/tokens', { ...m, description: 'evil', signature: await creatorAcct.signMessage({ message: msg }) });
    expect(tampered.status).toBe(401);
    // Unknown fields (e.g. trying to change on-chain columns) are stripped by the schema.
    const ok = await post('/api/tokens', { ...m, name: 'HACK', creator: otherAcct.address, signature: await creatorAcct.signMessage({ message: msg }) });
    expect(ok.status).toBe(200);

    const [t] = await db.select().from(tokens).where(eq(tokens.asset, PAID));
    expect(t).toMatchObject({ name: 'T0', creator: CREATOR, imageUrl: m.imageUrl, xHandle: 'nullsight', website: m.website, description: 'hi' });

    // Replaying the same signed update (or an older one) is rejected.
    expect((await post('/api/tokens', { ...m, signature: await creatorAcct.signMessage({ message: msg }) })).status).toBe(409);
    const stale = { asset: PAID, description: 'old', issuedAt: now() - 3600 };
    expect((await post('/api/tokens', { ...stale, signature: await creatorAcct.signMessage({ message: tokenMetadataMessage(stale) }) })).status).toBe(400);
  });

  it('POST /api/services is rejected for an unlisted token', async () => {
    const m = { asset: UNPAID, slug: 'unpaid-svc', name: 'x', upstreamUrl: 'https://example.com', priceUsdc: '1000', issuedAt: now() };
    const svc = { ...m, signature: await creatorAcct.signMessage({ message: serviceCreateMessage(m) }) };
    const res = await post('/api/services', svc);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/not listed/);
    expect(await db.select().from(services).where(eq(services.slug, 'unpaid-svc'))).toHaveLength(0);
  });
});

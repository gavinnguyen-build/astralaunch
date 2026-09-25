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
}));

const { tokens, services, idxRegistrations } = await import('../db/schema.js');
const { consumeForRegistration, verifyLaunchFee } = await import('../services/launchFee.js');
const { LAUNCH_FEE_TREASURY, LAUNCH_FEE_WEI } = await import('@astralaunch/shared');
const tokensRouter   = (await import('../routes/tokens.js')).default;
const explorerRouter = (await import('../routes/explorer.js')).default;
const adminRouter    = (await import('../routes/admin.js')).default;

const LAUNCHER = '0x1111111111111111111111111111111111111111';
const CREATOR  = '0x2222222222222222222222222222222222222222';
const PAID     = '0x' + 'a'.repeat(40);  // fee paid by LAUNCHER, creator = CREATOR
const UNPAID   = '0x' + 'b'.repeat(40);  // registered on-chain, no fee
const FEE_TX   = '0x' + '1'.repeat(64);

describe('token visibility', () => {
  let db: TestDb; let close: () => Promise<void>;
  const app = new Hono();
  app.route('/api/tokens', tokensRouter);
  app.route('/api/explorer', explorerRouter);
  app.route('/api/admin', adminRouter);

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
      await db.transaction(async (tx) => {
        await tx.insert(idxRegistrations).values(reg);
        await consumeForRegistration(tx, reg);
      });
      await db.insert(tokens).values({ asset: a, name: `T${i}`, symbol: `T${i}`, creator: CREATOR, router: reg.router });
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
});

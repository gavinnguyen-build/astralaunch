/** GET /api/tokens: counts, total, filter, search, paging and validation over listed tokens only. */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Hono } from 'hono';
import { createTestDb, type TestDb } from './helpers/pgliteDb.js';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../db/client.js', () => ({ get db() { return h.db; } }));
vi.mock('../env.js', () => ({
  RPC_URL: 'http://127.0.0.1:1', CHAIN_ID: 143, SUBMITTERS: [],
  REGISTRY_ADDR: '0x0000000000000000000000000000000000000001',
  USDC_ADDR: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', PAYMENT_TIMEOUT_S: 60,
}));

const { services, idxRegistrations, hiddenTokens } = await import('../db/schema.js');
const { upsertTokenFromRegistration } = await import('../services/tokenSync.js');
const { adminListAsset } = await import('../services/launchFee.js');
const tokensRouter = (await import('../routes/tokens.js')).default;

const asset = (i: number) => `0x${(0xa00 + i).toString(16).padStart(40, '0')}`;
type ListBody = { tokens: { asset: string; symbol: string; service: unknown }[]; total: number; counts: Record<string, number>; limit: number; offset: number; sort: string; dir: string; filter: string };

describe('GET /api/tokens (list)', () => {
  let db: TestDb; let close: () => Promise<void>;
  const app = new Hono();
  app.route('/api/tokens', tokensRouter);
  const get = async (qs = '') => {
    const res = await app.request(`/api/tokens${qs}`);
    return { status: res.status, body: await res.json() as ListBody };
  };

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    h.db = db;
    // 30 listed tokens (every third without a service), 1 unlisted, 1 listed but hidden.
    for (let i = 0; i < 32; i++) {
      const reg = {
        chainId: 143, txHash: `0x${(i + 1).toString(16).padStart(64, '0')}`, logIndex: 0, asset: asset(i),
        creator: `0x${'c'.repeat(40)}`, router: `0x${(0xb00 + i).toString(16).padStart(40, '0')}`, poolId: '0x00',
        numeraire: '', initializer: '', launcher: `0x${'9'.repeat(40)}`, blockNumber: BigInt(10 + i), timestamp: 1_800_000_000n + BigInt(i),
      };
      await db.insert(idxRegistrations).values(reg);
      await upsertTokenFromRegistration(db, reg, { name: `Token ${i}`, symbol: i === 7 ? 'SIGHT' : `T${i}`, decimals: 18 });
      if (i === 30) continue;                                  // unlisted
      await adminListAsset(db, asset(i), 143, 'test');
      if (i % 3 !== 0) {
        await db.insert(services).values({
          slug: `svc-${i}`, name: `svc ${i}`, asset: asset(i), router: reg.router, creator: reg.creator,
          upstreamUrl: 'https://example.com', priceUsdc: '1000', upstreamSecret: 's',
        });
      }
    }
    await db.insert(hiddenTokens).values({ asset: asset(31), reason: 'test' });
  });
  afterAll(async () => { await close(); });

  it('returns total and per-filter counts over listed, visible tokens only', async () => {
    const { status, body } = await get('?limit=25');
    expect(status).toBe(200);
    expect(body.total).toBe(30);
    expect(body.counts.all).toBe(30);
    expect(body.counts['no-service']).toBe(10);
    expect(body.counts.new).toBe(30);                 // launched just now in the test DB
    expect(body.counts['with-revenue']).toBe(0);
    expect(body.tokens).toHaveLength(25);
    expect(body.tokens.map((t) => t.asset)).not.toContain(asset(30));
    expect(body.tokens.map((t) => t.asset)).not.toContain(asset(31));
    expect(body).toMatchObject({ limit: 25, offset: 0, sort: 'revenue', dir: 'desc', filter: 'all' });
  });

  it('pages: 26–30 on page 2, no overlap with page 1', async () => {
    const p1 = (await get('?limit=25&offset=0')).body.tokens.map((t) => t.asset);
    const p2 = (await get('?limit=25&offset=25')).body.tokens.map((t) => t.asset);
    expect(p2).toHaveLength(5);
    expect(p1.filter((a) => p2.includes(a))).toEqual([]);
  });

  it('filter and search apply on the server, counts follow the search', async () => {
    const ns = await get('?filter=no-service&limit=100');
    expect(ns.body.total).toBe(10);
    expect(ns.body.tokens).toHaveLength(10);
    expect(ns.body.tokens.every((t) => t.service === null)).toBe(true);
    const s = await get('?q=sight');
    expect(s.body.tokens.map((t) => t.symbol)).toEqual(['SIGHT']);
    expect(s.body.counts.all).toBe(1);
  });

  it('keeps the legacy parameters working (sort=clean_revenue_30d, sort=new, days)', async () => {
    expect((await get('?sort=clean_revenue_30d&limit=100&days=30')).body.total).toBe(30);
    const newest = await get('?sort=new&limit=1');
    expect(newest.body.tokens[0]!.asset).toBe(asset(29));   // newest listed, visible token
  });

  it('rejects invalid parameters with 400', async () => {
    for (const qs of ['?limit=0', '?limit=500', '?offset=-5', '?days=14', '?sort=hype', '?dir=sideways', '?filter=hot']) {
      expect((await app.request(`/api/tokens${qs}`)).status).toBe(400);
    }
  });
});

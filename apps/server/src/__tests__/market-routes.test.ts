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
}));
vi.mock('../lib/chain.js', () => ({
  usdResolver: async () => ({ price: 10n ** 8n, decimals: 8 }),
  holderLabels: () => ({}),
  creatorChain: {},
  publicClient: {},
}));

const { tokens, idxSwaps } = await import('../db/schema.js');
const { adminListAsset } = await import('../services/launchFee.js');
const tokensRouter = (await import('../routes/tokens.js')).default;
const leaderboardRouter = (await import('../routes/leaderboard.js')).default;
const creatorRouter = (await import('../routes/creator.js')).default;

const LISTED = '0x' + 'a'.repeat(40), HIDDEN = '0x' + 'b'.repeat(40);
const USDC = '0x754704bc059f8c67012fed69bc8a327a5aafb603';

describe('market routes', () => {
  let db: TestDb; let close: () => Promise<void>;
  const app = new Hono();
  app.route('/api/tokens', tokensRouter);
  app.route('/api/leaderboard', leaderboardRouter);
  app.route('/api/creator', creatorRouter);

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    h.db = db;
    for (const a of [LISTED, HIDDEN]) {
      await db.insert(tokens).values({ asset: a, name: 'x', symbol: 'X', creator: '0x' + '1'.repeat(40), router: '0x' + '2'.repeat(40), numeraire: USDC });
    }
    await adminListAsset(db, LISTED, 143, 'test');
    await db.insert(idxSwaps).values({ chainId: 143, txHash: '0x1', logIndex: 0, poolId: '0xp', asset: LISTED, numeraire: USDC,
      sender: '0x6', txFrom: '0x7', assetDelta: (10n ** 21n).toString(), numeraireDelta: '-2500', sqrtPriceX96: '1', liquidity: '1',
      tick: 0, fee: 20000, priceWad: '2500000000000', isBuyback: false, blockNumber: 1n, timestamp: 1_800_000_000n });
  });
  afterAll(async () => { await close(); });

  it('candles / trades / holders for a listed token; tf is validated', async () => {
    const c = await (await app.request(`/api/tokens/${LISTED}/candles?tf=4h`)).json() as { candles: unknown[]; tf: string };
    expect(c.tf).toBe('4h');
    expect(c.candles).toHaveLength(1);
    expect((await app.request(`/api/tokens/${LISTED}/candles?tf=2m`)).status).toBe(400);
    expect(((await (await app.request(`/api/tokens/${LISTED}/trades`)).json()) as { trades: unknown[] }).trades).toHaveLength(1);
    expect((await app.request(`/api/tokens/${LISTED}/holders`)).status).toBe(200);
  });

  it('unlisted tokens stay hidden on the new endpoints', async () => {
    for (const p of ['candles', 'trades', 'holders']) expect((await app.request(`/api/tokens/${HIDDEN}/${p}`)).status).toBe(404);
  });

  it('list includes market data (price, 24h change, mcap)', async () => {
    const body = await (await app.request('/api/tokens')).json() as { tokens: { asset: string; market: { price: string; mcapUsd: string } }[] };
    expect(body.tokens.map(t => t.asset)).toEqual([LISTED]);
    expect(body.tokens[0]!.market).toMatchObject({ price: '0.0000025', numeraireSymbol: 'USDC' });
  });

  it('leaderboard: traders coming soon; bad period 400; creators list', async () => {
    expect(await (await app.request('/api/leaderboard?group=traders')).json()).toMatchObject({ comingSoon: true, traders: [] });
    expect((await app.request('/api/leaderboard?period=1y')).status).toBe(400);
    const c = await (await app.request('/api/leaderboard?group=creators&period=all')).json() as { creators: { creator: string }[] };
    expect(c.creators.map(x => x.creator)).toEqual(['0x' + '1'.repeat(40)]);
  });

  it('creator dashboard validates the wallet', async () => {
    expect((await app.request('/api/creator/not-an-address')).status).toBe(400);
  });
});

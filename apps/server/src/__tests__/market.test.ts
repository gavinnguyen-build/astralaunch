/**
 * Market services (D-MK1) on real Postgres (PGlite): price / 24h change / supply / mcap,
 * candles, trades, holders, USD resolver, creator leaderboard, creator dashboard.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from './helpers/pgliteDb.js';
import { idxSwaps, idxPoolInits, idxAssetTransfers, idxUsdcTransfers, tokens, gatewayRequests, services } from '../db/schema.js';
import { adminListAsset } from '../services/launchFee.js';
import { marketSnapshot, candles, trades, holders, DEAD, ZERO, type UsdResolver } from '../services/market.js';
import { createUsdResolver } from '../services/usdRates.js';
import { creatorLeaderboard } from '../services/leaderboard.js';
import { creatorDashboard, type CreatorChain } from '../services/creatorDashboard.js';

const USDC = '0x754704bc059f8c67012fed69bc8a327a5aafb603';
const WMON = '0x3bd359c1119da7da1d913d1c4d2b7c461115433a';
const VAULT = '0x394f1dca6011c16bc6e70ca13f6f29767d92171e';
const PM = '0x188d586ddcf52439676ca21a244753fa19f9ea8e';
const SIGHT = '0x30ae380593a04c14abfa994969b718a78a6105ad';   // USDC pair, SIGHT is currency0
const FEED = '0x2686619d5569aebcdfec774e8a2167de78376ddf';    // WMON pair, FEED is currency0
const CREATOR = '0x11e2dd9a4b9062675fd89178a2c9778182dfcbc6';
const OTHER_CREATOR = '0x' + '4'.repeat(40);
const TRADER = '0x' + '7'.repeat(40);
const T0 = 1_800_000_000n;                                     // "now" in tests
const E18 = 10n ** 18n;

const usd: UsdResolver = async (n) =>
  n === USDC ? { price: 10n ** 8n, decimals: 8 } : n === WMON ? { price: 2_562_000n, decimals: 8 } : null;

let seq = 0;
const hash = () => `0x${(++seq).toString(16).padStart(64, '0')}`;

async function swap(db: TestDb, asset: string, numeraire: string, ts: bigint, priceWad: bigint, assetDelta: bigint, numDelta: bigint, buyback = false) {
  await db.insert(idxSwaps).values({
    chainId: 143, txHash: hash(), logIndex: 0, poolId: '0xpool', asset, numeraire,
    sender: buyback ? VAULT : '0x' + '6'.repeat(40), txFrom: TRADER,
    assetDelta: assetDelta.toString(), numeraireDelta: numDelta.toString(), sqrtPriceX96: '1', liquidity: '1', tick: 0, fee: 20000,
    priceWad: priceWad.toString(), isBuyback: buyback, blockNumber: BigInt(seq), timestamp: ts,
  });
}
async function transfer(db: TestDb, asset: string, from: string, to: string, value: bigint) {
  await db.insert(idxAssetTransfers).values({ chainId: 143, txHash: hash(), logIndex: 0, asset,
    fromAddr: from, toAddr: to, value: value.toString(), blockNumber: BigInt(seq), timestamp: T0 });
}

describe('market', () => {
  let db: TestDb; let close: () => Promise<void>;
  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    await db.insert(idxPoolInits).values({ chainId: 143, txHash: '0xinit', logIndex: 0, poolId: '0xpool', asset: SIGHT,
      sqrtPriceX96: '1', priceWad: (2_500_000_000_000n).toString(), blockNumber: 1n, timestamp: T0 - 200_000n }); // 2.5e-6
    // SIGHT: 2 days ago 2.5e-6; 23h ago 3e-6 (buy); ~50 min ago buyback at 3.3e-6; 10 min ago sell at 3.2e-6
    await swap(db, SIGHT, USDC, T0 - 172_800n, 2_500_000_000_000n, 1000n * E18, -2_500n);
    await swap(db, SIGHT, USDC, T0 - 82_800n, 3_000_000_000_000n, 1000n * E18, -3_000n);
    await swap(db, SIGHT, USDC, T0 - 3_000n, 3_300_000_000_000n, 58_006n * E18, -150_000n, true);
    await swap(db, SIGHT, USDC, T0 - 600n, 3_200_000_000_000n, -500n * E18, 1_600n);
    // supply: 1e9 minted to PoolManager; 58,006 bought back and burned (to 0x…dEaD)
    await transfer(db, SIGHT, ZERO, PM, 1_000_000_000n * E18);
    await transfer(db, SIGHT, PM, TRADER, 2_000n * E18);
    await transfer(db, SIGHT, PM, VAULT, 58_006n * E18);
    await transfer(db, SIGHT, VAULT, DEAD, 58_006n * E18);
  });
  afterEach(async () => { await close(); });

  it('snapshot: last price, 24h change vs price 24h ago, supply after burn, mcap', async () => {
    const m = await marketSnapshot(db, SIGHT, USDC, usd, T0);
    expect(m.price).toBe('0.0000032');
    expect(m.priceUsd).toBe('0.0000032');
    expect(m.change24hBps).toBe(2800);             // 24h ago the price was 2.5e-6 → +28%
    expect(m.supply).toBe('999941994');
    expect(Number(m.mcapUsd)).toBeCloseTo(3199.81, 1);
    expect(m.trades24h).toBe(3);
    expect(m.numeraireSymbol).toBe('USDC');
  });

  it('MON pair converts with the Chainlink rate; a token younger than 24h compares with its launch price', async () => {
    await db.insert(idxPoolInits).values({ chainId: 143, txHash: '0xinit2', logIndex: 0, poolId: '0xfeed', asset: FEED,
      sqrtPriceX96: '1', priceWad: (97_400_000_000_000n).toString(), blockNumber: 2n, timestamp: T0 - 3_600n }); // 9.74e-5 WMON
    await swap(db, FEED, WMON, T0 - 60n, 100_000_000_000_000n, 58_477n * E18, -5_803n * 10n ** 15n, true);   // 1e-4 WMON
    const m = await marketSnapshot(db, FEED, WMON, usd, T0);
    expect(m.price).toBe('0.0001');
    expect(m.priceUsd).toBe('0.000002562');          // 1e-4 × $0.02562
    expect(m.change24hBps).toBe(266);                // vs launch 9.74e-5
    expect(m.numeraireSymbol).toBe('MON');
    const none = await marketSnapshot(db, FEED, WMON, async () => null, T0);
    expect(none.priceUsd).toBeNull();
    expect(none.mcapUsd).toBeNull();
  });

  it('candles: OHLC by bucket in trade order, volume, buyback count', async () => {
    const day = await candles(db, SIGHT, USDC, '1d', usd);
    expect(day.candles.reduce((a, c) => a + c.trades, 0)).toBe(4);
    expect(day.candles.reduce((a, c) => a + c.buybacks, 0)).toBe(1);
    expect(day.candles.map(c => c.time)).toEqual([...day.candles.map(c => c.time)].sort((a, b) => a - b));
    const hourly = await candles(db, SIGHT, USDC, '1h', usd);
    // buyback (T0-3000s) then sell (T0-600s) share the last hourly bucket: open = first, close = last
    const bb = hourly.candles.find(c => c.buybacks === 1)!;
    expect(bb).toMatchObject({ open: '0.0000033', close: '0.0000032', volume: '0.1516', volumeUsd: '0.1516', trades: 2 });
    await swap(db, SIGHT, USDC, T0 - 590n, 3_500_000_000_000n, 10n * E18, -35n);
    await swap(db, SIGHT, USDC, T0 - 580n, 3_100_000_000_000n, -10n * E18, 31n);
    const last = (await candles(db, SIGHT, USDC, '1h', usd)).candles.at(-1)!;
    expect(last).toMatchObject({ open: '0.0000033', high: '0.0000035', low: '0.0000031', close: '0.0000031', trades: 4, buybacks: 1 });
  });

  it('trades: newest first, buy/sell/buyback sides, amounts, pagination', async () => {
    const p1 = await trades(db, SIGHT, USDC, usd, 2);
    expect(p1.trades.map(t => t.side)).toEqual(['sell', 'buyback']);
    expect(p1.trades[1]).toMatchObject({ isBuyback: true, assetAmount: '58006', numeraireAmount: '0.15', valueUsd: '0.15', trader: TRADER });
    expect(p1.trades[0]).toMatchObject({ assetAmount: '500', numeraireAmount: '0.0016' });
    const p2 = await trades(db, SIGHT, USDC, usd, 2, p1.nextBefore!);
    expect(p2.trades.map(t => t.side)).toEqual(['buy', 'buy']);
    expect(p2.nextBefore).toBeNull();
  });

  it('holders: balances from transfers, labels, burn and zero address excluded', async () => {
    const h = await holders(db, SIGHT, { [PM]: 'Uniswap v4 pool' });
    expect(h.holderCount).toBe(2);
    expect(h.holders[0]).toMatchObject({ address: PM, label: 'Uniswap v4 pool', balance: '999939994' });
    expect(h.holders[1]).toMatchObject({ address: TRADER, balance: '2000', label: null });
    expect(h.holders.map(x => x.address)).not.toContain(DEAD);
  });
});

describe('USD resolver', () => {
  it('USDC is $1; MON via Chainlink; stale feed or RPC error → null; cached', async () => {
    const read = vi.fn(async () => ({ answer: 2_562_000n, updatedAt: 1_000n, decimals: 8 }));
    const fresh = createUsdResolver(read, () => 1_100n);
    expect(await fresh(USDC)).toEqual({ price: 10n ** 8n, decimals: 8 });
    expect(await fresh(WMON)).toEqual({ price: 2_562_000n, decimals: 8 });
    await fresh(WMON);
    expect(read).toHaveBeenCalledTimes(1);
    expect(await createUsdResolver(read, () => 1_000n + 3_601n)(WMON)).toBeNull();
    expect(await createUsdResolver(async () => { throw new Error('rpc'); })(WMON)).toBeNull();
  });
});

describe('creator leaderboard + dashboard', () => {
  let db: TestDb; let close: () => Promise<void>;
  const HIDDEN = '0x' + 'd'.repeat(40);
  async function token(asset: string, creator: string, router: string, numeraire: string, symbol: string, list = true) {
    await db.insert(tokens).values({ asset, name: symbol.toLowerCase(), symbol, creator, router, numeraire, poolId: `0x${asset.slice(2, 10)}`,
      launchedAt: new Date(Number(T0 - 50n * 86_400n) * 1000) });
    if (list) await adminListAsset(db, asset, 143, 'test');
  }
  async function pay(router: string, from: string, value: bigint, ts: bigint, facilitator = true) {
    await db.insert(idxUsdcTransfers).values({ chainId: 143, txHash: hash(), logIndex: 0, fromAddr: from, toAddr: router,
      value: value.toString(), txFrom: '0xfac', isFacilitatorSettled: facilitator, blockNumber: BigInt(seq), timestamp: ts });
  }
  const R = (n: string) => '0x' + n.repeat(20);
  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    await token(SIGHT, CREATOR, R('a1'), USDC, 'SIGHT');
    await token(FEED, CREATOR, R('a2'), WMON, 'FEED');
    await token('0x' + 'c'.repeat(40), OTHER_CREATOR, R('a3'), USDC, 'OTHER');
    await token(HIDDEN, '0x' + '5'.repeat(40), R('a4'), USDC, 'HIDDEN', false);
    const agent = '0x' + '9'.repeat(40);
    await pay(R('a1'), agent, 500_000n, T0 - 3_600n);              // clean 0.5
    await pay(R('a2'), agent, 500_000n, T0 - 40n * 86_400n);       // clean, 40 days ago
    await pay(R('a1'), CREATOR, 900_000n, T0 - 60n);               // creator: excluded
    await pay(R('a1'), agent, 700_000n, T0 - 60n, false);          // not facilitator-settled
    await pay(R('a3'), agent, 800_000n, T0 - 60n);                 // other creator 0.8
    await pay(R('a4'), agent, 9_000_000n, T0 - 60n);               // unlisted token: ignored
  });
  afterEach(async () => { await close(); });
  const platform = { escrow: R('e1'), vault: VAULT, registry: R('e2') };

  it('ranks creators by clean revenue per period; unlisted tokens ignored', async () => {
    const d30 = await creatorLeaderboard(db, '30d', T0, platform);
    expect(d30.creators.map(c => [c.creator, c.cleanRevenueUsdc])).toEqual([[OTHER_CREATOR, '0.8'], [CREATOR, '0.5']]);
    expect(d30.creators[1]!.rawRevenueUsdc).toBe('2.1');
    expect(d30.creators[1]!.tokens.map(t => t.symbol).sort()).toEqual(['FEED', 'SIGHT']);
    const all = await creatorLeaderboard(db, 'all', T0, platform);
    expect(all.creators.map(c => [c.creator, c.cleanRevenueUsdc])).toEqual([[CREATOR, '1'], [OTHER_CREATOR, '0.8']]);
    expect(all.creators.map(c => c.creator)).not.toContain('0x' + '5'.repeat(40));
    expect((await creatorLeaderboard(db, '7d', T0, platform)).creators.map(c => c.cleanRevenueUsdc)).toEqual(['0.8', '0.5']);
  });

  it('dashboard: fees per numeraire side, escrow USDC vs WMON, vesting, services, requests; chain errors → null', async () => {
    const [svc] = await db.insert(services).values({ slug: 'nullsight', name: 'n', asset: SIGHT, router: R('a1'),
      creator: CREATOR, upstreamUrl: 'http://127.0.0.1:4001', priceUsdc: '500000', upstreamSecret: 'secret' }).returning();
    await db.insert(gatewayRequests).values({ serviceId: svc!.id, asset: SIGHT, payer: '0x9', amountUsdc: '500000', statusCode: 200,
      upstreamStatus: 200, latencyMs: 612, verified: true, settled: true, settleTxHash: '0xabc' });
    const chain: CreatorChain = {
      tradingFees: async () => ({ fees0: 10n * E18, fees1: 1_000_000n, share: 35n * 10n ** 16n }),  // SIGHT/FEED are currency0
      escrowClaimable: async (_a, wmon) => (wmon ? 2n * E18 : 138_000_000n),
      escrowData: async () => ({ creator: CREATOR, launchTime: 1_790_000_000, forfeited: false, usdcAccrued: 1n, usdcClaimed: 0n, recordedRevenue: 500_000n }),
      vesting: async (a) => {
        if (a === FEED) throw new Error('rpc');
        return { total: 150_000_000n * E18, released: 0n, releasable: 4_300_000n * E18, start: 1_790_000_000, cliffS: 2_592_000, durationS: 31_536_000 };
      },
    };
    const d = await creatorDashboard(db, chain, CREATOR.toUpperCase().replace('0X', '0x'));
    const sight = d.tokens.find(t => t.symbol === 'SIGHT')!;
    const feed = d.tokens.find(t => t.symbol === 'FEED')!;
    expect(sight.tradingFees).toMatchObject({ numeraire: '0.35', asset: '3.5', estimated: true });
    expect(sight.escrow).toMatchObject({ claimable: '138', claimableSymbol: 'USDC', recordedRevenue: '0.5' });
    expect(feed.escrow).toMatchObject({ claimable: '2', claimableSymbol: 'WMON' });
    expect(sight.vesting).toMatchObject({ total: '150000000', releasable: '4300000', locked: '145700000', cliffEnd: 1_792_592_000 });
    expect(feed.vesting).toBeNull();
    expect(d.services).toHaveLength(1);
    expect(d.services[0]).not.toHaveProperty('upstreamSecret');
    expect(d.recentRequests[0]).toMatchObject({ service: 'nullsight', charged: true, amountUsdc: '0.5', latencyMs: 612 });
    expect((await creatorDashboard(db, chain, '0x' + '8'.repeat(40))).tokens).toEqual([]);
    await db.execute(sql`SELECT 1`);
  });
});

describe('rowsOf (driver shapes)', async () => {
  const { rowsOf } = await import('../services/market.js');
  it('accepts postgres-js arrays and PGlite { rows }', () => {
    expect(rowsOf([{ a: 1 }])).toEqual([{ a: 1 }]);
    expect(rowsOf({ rows: [{ a: 1 }] })).toEqual([{ a: 1 }]);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from './helpers/pgliteDb.js';
import {
  gatewayRequests, idxDistributions, idxPoolInits, idxSwaps, idxUsdcTransfers, serviceProbes, services, tokens,
} from '../db/schema.js';
import { adminListAsset } from '../services/launchFee.js';
import { classifiedPayments, platformStats, serviceHealth, sparkline7d, usageSummary } from '../services/usage.js';
import type { UsdResolver } from '../services/market.js';

const USDC = '0x754704bc059f8c67012fed69bc8a327a5aafb603';
const SIGHT = '0x30ae380593a04c14abfa994969b718a78a6105ad';
const ROUTER = '0x' + 'a1'.repeat(20);
const CREATOR = '0x11e2dd9a4b9062675fd89178a2c9778182dfcbc6';
const AGENT = '0x' + '9'.repeat(40);
const VAULT = '0x394f1dca6011c16bc6e70ca13f6f29767d92171e';
const T0 = 1_800_000_000n;
const usd: UsdResolver = async () => ({ price: 10n ** 8n, decimals: 8 });
const platform = { escrow: '0x' + 'e1'.repeat(20), vault: VAULT, registry: '0x' + 'e2'.repeat(20) };
const token = { asset: SIGHT, creator: CREATOR, router: ROUTER, numeraire: USDC };

let seq = 0;
const hash = () => `0x${(++seq).toString(16).padStart(64, '0')}`;

describe('usage', () => {
  let db: TestDb; let close: () => Promise<void>;
  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    await db.insert(tokens).values({ asset: SIGHT, name: 'nullsight', symbol: 'SIGHT', creator: CREATOR, router: ROUTER, numeraire: USDC });
    await adminListAsset(db, SIGHT, 143, 'test');
    const pay = (from: string, v: bigint, ts: bigint, fac = true) => db.insert(idxUsdcTransfers).values({ chainId: 143, txHash: hash(),
      logIndex: 0, fromAddr: from, toAddr: ROUTER, value: v.toString(), txFrom: '0xf', isFacilitatorSettled: fac, blockNumber: BigInt(seq), timestamp: ts });
    await pay(AGENT, 500_000n, T0 - 100n);
    await pay('0x' + '8'.repeat(40), 500_000n, T0 - 200n);
    await pay(CREATOR, 700_000n, T0 - 300n);
    await pay(AGENT, 300_000n, T0 - 400n, false);
    const swap = (num: bigint, buyback: boolean, ts: bigint) => db.insert(idxSwaps).values({ chainId: 143, txHash: hash(), logIndex: 0,
      poolId: '0xp', asset: SIGHT, numeraire: USDC, sender: buyback ? VAULT : '0x6', txFrom: '0x7', assetDelta: '1', numeraireDelta: (-num).toString(),
      sqrtPriceX96: '1', liquidity: '1', tick: 0, fee: 20000, priceWad: '2500000000000', isBuyback: buyback, blockNumber: BigInt(seq), timestamp: ts });
    await swap(100_000_000n, false, T0 - 1_000n);   // 100 USDC traded
    await swap(150_000n, true, T0 - 900n);          // buyback: excluded from UCR volume
  });
  afterEach(async () => { await close(); });

  it('clean revenue, payers, volume without buybacks, UCR = 150 × clean / volume', async () => {
    const u = await usageSummary(db, token, T0 - 30n * 86_400n, usd, platform);
    expect(u).toMatchObject({ cleanRevenueUsdc: '1', rawRevenueUsdc: '2', cleanPayers: 2, volume: '100', volumeUsd: '100' });
    expect(u.ucr).toBe('1.5');                       // 0.30·1 / (0.002·100)
    const none = await usageSummary(db, { ...token, asset: '0x' + 'f'.repeat(40) }, null, usd, platform);
    expect(none.ucr).toBeNull();                     // no trading volume → nothing to compare
  });

  it('classified payments carry the clean-revenue class', async () => {
    const rows = await classifiedPayments(db, token, platform);
    // newest block first (inserted last)
    expect(rows.map((r) => r.class)).toEqual(['not_facilitator', 'creator', 'clean', 'clean']);
    expect(rows[3]).toMatchObject({ payer: AGENT, amountUsdc: '0.5' });
  });

  it('service health: success rate, latency percentiles of settled calls, probe uptime', async () => {
    const [svc] = await db.insert(services).values({ slug: 's', name: 's', asset: SIGHT, router: ROUTER, creator: CREATOR,
      upstreamUrl: 'https://x', priceUsdc: '500000', upstreamSecret: 'k' }).returning();
    const now = Date.now();
    for (const [lat, settled] of [[100, true], [200, true], [300, true], [400, true], [20_000, false]] as const) {
      await db.insert(gatewayRequests).values({ serviceId: svc!.id, asset: SIGHT, payer: AGENT, amountUsdc: '500000',
        latencyMs: lat, verified: true, settled, createdAt: new Date(now - 60_000) });
    }
    for (const ok of [true, true, true, false]) await db.insert(serviceProbes).values({ serviceId: svc!.id, ok, checkedAt: new Date(now - 60_000) });
    const h = await serviceHealth(db, svc!.id, now);
    expect(h).toMatchObject({ successRate: 0.8, latencyP50Ms: 250, uptime7d: 0.75, calls7d: 5 });
    expect(h.latencyP95Ms).toBe(385);
  });

  it('platform stats and 7d change / sparkline', async () => {
    await db.insert(idxDistributions).values({ chainId: 143, txHash: hash(), logIndex: 0, asset: SIGHT, total: '500000',
      providerAmt: '300000', costAmt: '0', buybackAmt: '150000', treasuryAmt: '50000', blockNumber: 1n, timestamp: T0 });
    expect(await platformStats(db)).toMatchObject({ servicesLive: 0, paidToProvidersUsdc: '0.3', tokens: 1 });
    await db.insert(idxPoolInits).values({ chainId: 143, txHash: '0xi', logIndex: 0, poolId: '0xp', asset: SIGHT,
      sqrtPriceX96: '1', priceWad: '2000000000000', blockNumber: 1n, timestamp: T0 - 2n * 86_400n });
    const s = await sparkline7d(db, SIGHT, T0);
    expect(s.spark7d.length).toBeGreaterThan(0);
    expect(s.change7dBps).toBe(2500);               // 2.0e-6 at launch (younger than 7d) → 2.5e-6
  });
});

describe('isVerified (SPEC O5)', async () => {
  const { isVerified } = await import('../services/usage.js');
  it('needs ≥100 USDC clean revenue and ≥10 clean payers', () => {
    expect(isVerified({ cleanRevenueUsdc: '100', cleanPayers: 10 })).toBe(true);
    expect(isVerified({ cleanRevenueUsdc: '99.999999', cleanPayers: 50 })).toBe(false);
    expect(isVerified({ cleanRevenueUsdc: '5000.5', cleanPayers: 9 })).toBe(false);
    expect(isVerified(null)).toBe(false);
  });
});

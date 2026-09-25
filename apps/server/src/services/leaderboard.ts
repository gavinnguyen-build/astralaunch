/**
 * Creator leaderboard (D-MK1): listed tokens grouped by on-chain creator, ranked by clean
 * revenue (services/cleanRevenue.ts) over 7d / 30d / all. Traders: not built yet ("coming soon").
 */
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { formatUnits } from 'viem';
import { gatewayRequests, idxUsdcTransfers, tokens } from '../db/schema.js';
import { classifyTransfer, excludedPayers, type PlatformAddrs } from './cleanRevenue.js';
import { isListedSql, type Db } from './launchFee.js';
import { holderCount, type UsdResolver } from './market.js';
import { usageSummary } from './usage.js';

export const PERIODS = { '7d': 7 * 86_400, '30d': 30 * 86_400, all: null } as const;
export type Period = keyof typeof PERIODS;

export async function creatorLeaderboard(db: Db, period: Period, nowS: bigint, platform: PlatformAddrs, limit = 100, usd?: UsdResolver) {
  const secs = PERIODS[period];
  const since = secs === null ? 0n : nowS - BigInt(secs);
  const listed = await db.select({ asset: tokens.asset, symbol: tokens.symbol, name: tokens.name, creator: tokens.creator, router: tokens.router, numeraire: tokens.numeraire, xHandle: tokens.xHandle })
    .from(tokens).where(isListedSql(tokens.asset));
  if (listed.length === 0) return { group: 'creators' as const, period, creators: [] };

  const byRouter = new Map(listed.map((t) => [t.router.toLowerCase(), t]));
  const transfers = await db.select({
    toAddr: idxUsdcTransfers.toAddr, fromAddr: idxUsdcTransfers.fromAddr, value: idxUsdcTransfers.value,
    isFacilitatorSettled: idxUsdcTransfers.isFacilitatorSettled,
  }).from(idxUsdcTransfers).where(and(
    inArray(idxUsdcTransfers.toAddr, [...byRouter.keys()]),
    gte(idxUsdcTransfers.timestamp, since),
  ));

  const calls = await db.select({ asset: gatewayRequests.asset, n: sql<number>`COUNT(*)::int` })
    .from(gatewayRequests)
    .where(and(eq(gatewayRequests.settled, true), inArray(gatewayRequests.asset, listed.map((t) => t.asset)),
      gte(gatewayRequests.createdAt, new Date(Number(since) * 1000))))
    .groupBy(gatewayRequests.asset);
  const callsBy = new Map(calls.map((c) => [c.asset, c.n]));

  type Agg = { creator: string; tokens: { asset: string; symbol: string; name: string }[]; clean: bigint; raw: bigint; calls: number; holders: number; bestUcr: number | null };
  const agg = new Map<string, Agg>();
  for (const t of listed) {
    const a = agg.get(t.creator) ?? { creator: t.creator, tokens: [], clean: 0n, raw: 0n, calls: 0, holders: 0, bestUcr: null };
    a.tokens.push({ asset: t.asset, symbol: t.symbol, name: t.name });
    a.calls += callsBy.get(t.asset) ?? 0;
    a.holders += await holderCount(db, t.asset);
    if (usd && t.numeraire) {
      const u = await usageSummary(db, t, secs === null ? null : since, usd, platform);
      if (u.ucr !== null && (a.bestUcr === null || Number(u.ucr) > a.bestUcr)) a.bestUcr = Number(u.ucr);
    }
    agg.set(t.creator, a);
  }
  for (const tr of transfers) {
    const t = byRouter.get(tr.toAddr.toLowerCase())!;
    const a = agg.get(t.creator)!;
    const v = BigInt(tr.value);
    a.raw += v;
    if (classifyTransfer(tr, t.creator, excludedPayers(t.router, platform)) === 'clean') a.clean += v;
  }

  const ranked = [...agg.values()]
    .sort((x, y) => (y.clean > x.clean ? 1 : y.clean < x.clean ? -1 : y.calls - x.calls))
    .slice(0, limit);
  return {
    group: 'creators' as const, period,
    creators: ranked.map((a, i) => ({
      rank: i + 1, creator: a.creator, tokens: a.tokens,
      cleanRevenueUsdc: formatUnits(a.clean, 6), rawRevenueUsdc: formatUnits(a.raw, 6),
      paidCalls: a.calls, holders: a.holders, bestUcr: a.bestUcr === null ? null : a.bestUcr.toFixed(4),
    })),
  };
}

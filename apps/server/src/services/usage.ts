/**
 * Usage metrics for the web pages (D-MK2): clean revenue, payers, paid calls, volume, UCR,
 * service health, classified payments, platform totals, 7d change + sparkline.
 *
 * UCR (SPEC §13) = (0.30 × cleanRevenue) / (0.002 × volumeUsd) over the same window. Volume
 * excludes buyback swaps (they are funded by usage/trading, not independent trading). null when
 * there is no trading volume in the window (nothing to compare against).
 */
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { formatUnits } from 'viem';
import { mulPrice, changeBps, VERIFIED_MIN_CLEAN_PAYERS, VERIFIED_MIN_CLEAN_REVENUE_USDC } from '@astralaunch/shared';
import {
  gatewayRequests, idxDistributions, idxSwaps, idxUsdcTransfers, serviceProbes, services, tokens,
} from '../db/schema.js';
import { classifyTransfer, excludedPayers, type CleanClass, type PlatformAddrs } from './cleanRevenue.js';
import { isListedSql, type Db } from './launchFee.js';
import { launchPrice, numeraireDecimals, priceAt, type UsdResolver } from './market.js';

type TokenRef = { asset: string; creator: string; router: string; numeraire: string };

const usdc = (v: bigint) => formatUnits(v, 6);

export async function usageSummary(db: Db, t: TokenRef, sinceS: bigint | null, usd: UsdResolver, platform: PlatformAddrs) {
  const router = t.router.toLowerCase();
  const transfers = await db.select({
    fromAddr: idxUsdcTransfers.fromAddr, value: idxUsdcTransfers.value, isFacilitatorSettled: idxUsdcTransfers.isFacilitatorSettled,
  }).from(idxUsdcTransfers).where(and(
    eq(idxUsdcTransfers.toAddr, router),
    sinceS === null ? sql`TRUE` : gte(idxUsdcTransfers.timestamp, sinceS),
  ));
  const excluded = excludedPayers(router, platform);
  let raw = 0n, clean = 0n;
  const payers = new Set<string>();
  for (const tr of transfers) {
    const v = BigInt(tr.value);
    raw += v;
    if (classifyTransfer(tr, t.creator, excluded) === 'clean') { clean += v; payers.add(tr.fromAddr.toLowerCase()); }
  }

  const [calls] = await db.select({ n: sql<number>`COUNT(*)::int` }).from(gatewayRequests).where(and(
    eq(gatewayRequests.asset, t.asset), eq(gatewayRequests.settled, true),
    sinceS === null ? sql`TRUE` : gte(gatewayRequests.createdAt, new Date(Number(sinceS) * 1000)),
  ));

  const [vol] = await db.select({ v: sql<string>`COALESCE(SUM(ABS(${idxSwaps.numeraireDelta})), 0)` }).from(idxSwaps).where(and(
    eq(idxSwaps.asset, t.asset), eq(idxSwaps.isBuyback, false),
    sinceS === null ? sql`TRUE` : gte(idxSwaps.timestamp, sinceS),
  ));
  const nd = numeraireDecimals(t.numeraire);
  const volNum = BigInt(vol?.v ?? '0');
  const rate = await usd(t.numeraire);
  const volUsdWad = rate ? mulPrice(volNum * 10n ** BigInt(18 - nd), rate.price, rate.decimals) : null;
  const cleanWad = clean * 10n ** 12n;
  // UCR = 0.30·clean / (0.002·volume) = 150·clean / volume
  const ucr = volUsdWad && volUsdWad > 0n ? formatUnits((150n * cleanWad * 10n ** 18n) / volUsdWad, 18) : null;
  return {
    cleanRevenueUsdc: usdc(clean), rawRevenueUsdc: usdc(raw), cleanPayers: payers.size, paidCalls: calls?.n ?? 0,
    volume: formatUnits(volNum, nd), volumeUsd: volUsdWad === null ? null : formatUnits(volUsdWad, 18), ucr,
  };
}

/** Success rate, latency percentiles (settled calls) and probe uptime over the last 7 days. */
export async function serviceHealth(db: Db, serviceId: string, nowMs = Date.now()) {
  const since = new Date(nowMs - 7 * 86_400_000);
  const [r] = await db.select({
    total: sql<number>`COUNT(*) FILTER (WHERE ${gatewayRequests.verified})::int`,
    ok: sql<number>`COUNT(*) FILTER (WHERE ${gatewayRequests.settled})::int`,
    p50: sql<number | null>`percentile_cont(0.5) WITHIN GROUP (ORDER BY ${gatewayRequests.latencyMs}) FILTER (WHERE ${gatewayRequests.settled})`,
    p95: sql<number | null>`percentile_cont(0.95) WITHIN GROUP (ORDER BY ${gatewayRequests.latencyMs}) FILTER (WHERE ${gatewayRequests.settled})`,
  }).from(gatewayRequests).where(and(eq(gatewayRequests.serviceId, serviceId), gte(gatewayRequests.createdAt, since)));
  const [p] = await db.select({
    total: sql<number>`COUNT(*)::int`, ok: sql<number>`COUNT(*) FILTER (WHERE ${serviceProbes.ok})::int`,
  }).from(serviceProbes).where(and(eq(serviceProbes.serviceId, serviceId), gte(serviceProbes.checkedAt, since)));
  return {
    successRate: r && r.total > 0 ? r.ok / r.total : null,
    latencyP50Ms: r?.p50 == null ? null : Math.round(Number(r.p50)),
    latencyP95Ms: r?.p95 == null ? null : Math.round(Number(r.p95)),
    uptime7d: p && p.total > 0 ? p.ok / p.total : null,
    calls7d: r?.total ?? 0,
  };
}

/** Indexed router inflows with the clean-revenue class and how many services the payer paid. */
export async function classifiedPayments(db: Db, t: TokenRef, platform: PlatformAddrs, limit = 20) {
  const rows = await db.select().from(idxUsdcTransfers)
    .where(eq(idxUsdcTransfers.toAddr, t.router.toLowerCase()))
    .orderBy(desc(idxUsdcTransfers.blockNumber), desc(idxUsdcTransfers.logIndex)).limit(limit);
  const payers = [...new Set(rows.map((r) => r.fromAddr.toLowerCase()))];
  const svcCounts = payers.length === 0 ? [] : await db.select({
    payer: gatewayRequests.payer, n: sql<number>`COUNT(DISTINCT ${gatewayRequests.serviceId})::int`,
  }).from(gatewayRequests).where(and(inArray(gatewayRequests.payer, payers), eq(gatewayRequests.settled, true)))
    .groupBy(gatewayRequests.payer);
  const byPayer = new Map(svcCounts.map((s) => [s.payer, s.n]));
  const excluded = excludedPayers(t.router, platform);
  return rows.map((r) => ({
    payer: r.fromAddr, amountUsdc: usdc(BigInt(r.value)), txHash: r.txHash, timestamp: Number(r.timestamp),
    class: classifyTransfer(r, t.creator, excluded) as CleanClass,
    payerServices: byPayer.get(r.fromAddr.toLowerCase()) ?? 0,
  }));
}

/** Platform totals for the home hero (listed tokens only). */
export async function platformStats(db: Db) {
  const [s] = await db.select({ n: sql<number>`COUNT(*)::int` }).from(services)
    .where(and(eq(services.active, true), isListedSql(services.asset)));
  const [c] = await db.select({ n: sql<number>`COUNT(*)::int` }).from(gatewayRequests)
    .where(and(eq(gatewayRequests.settled, true), isListedSql(gatewayRequests.asset)));
  const [p] = await db.select({ v: sql<string>`COALESCE(SUM(${idxDistributions.providerAmt}), 0)` }).from(idxDistributions)
    .where(isListedSql(idxDistributions.asset));
  const [tk] = await db.select({ n: sql<number>`COUNT(*)::int` }).from(tokens).where(isListedSql(tokens.asset));
  return { servicesLive: s?.n ?? 0, paidCalls: c?.n ?? 0, paidToProvidersUsdc: usdc(BigInt(p?.v ?? '0')), tokens: tk?.n ?? 0 };
}

/** 7d change and a 28-point (6h) price sparkline in numeraire; points before launch are skipped. */
export async function sparkline7d(db: Db, asset: string, nowS: bigint) {
  const pts: number[] = [];
  for (let i = 27; i >= 0; i--) {
    const p = await priceAt(db, asset, nowS - BigInt(i) * 21_600n);
    if (p !== null) pts.push(Number(formatUnits(p, 18)));
  }
  const now = await priceAt(db, asset, nowS);
  const weekAgo = await priceAt(db, asset, nowS - 7n * 86_400n);
  // Younger than 7 days: change since launch.
  return { spark7d: pts, change7dBps: now === null ? null : changeBps(now, weekAgo ?? (await launchPrice(db, asset))) };
}

/** SPEC O5 Verified badge from an all-time usage summary. */
export function isVerified(u: { cleanRevenueUsdc: string; cleanPayers: number } | null): boolean {
  if (!u) return false;
  const [whole, frac = ''] = u.cleanRevenueUsdc.split('.');
  const raw = BigInt(whole!) * 1_000_000n + BigInt((frac + '000000').slice(0, 6));
  return raw >= VERIFIED_MIN_CLEAN_REVENUE_USDC && u.cleanPayers >= VERIFIED_MIN_CLEAN_PAYERS;
}

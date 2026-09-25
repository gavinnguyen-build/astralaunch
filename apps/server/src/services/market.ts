/**
 * Market data for the web app (docs/decisions.md D-MK1): price, 24h change, market cap,
 * candles, trades, holders, all from indexed v4 swaps / pool inits / asset transfers.
 *
 * Prices are exact bigints scaled by 1e18 (asset price in numeraire). USD conversion:
 * USDC pairs at 1 USDC = 1 USD; MON pairs via the Chainlink MON/USD feed, using the CURRENT
 * feed price for historical values too (display only; no money math depends on it).
 * Pure DB + injected USD resolver: no env imports.
 */
import { and, desc, eq, lte, sql } from 'drizzle-orm';
import { formatUnits } from 'viem';
import {
  NUMERAIRE_DECIMALS, TOTAL_SUPPLY, USDC, WMON, changeBps, mulPrice,
} from '@astralaunch/shared';
import { idxAssetTransfers, idxPoolInits, idxSwaps } from '../db/schema.js';
import type { Db } from './launchFee.js';

export const ZERO = '0x0000000000000000000000000000000000000000';
export const DEAD = '0x000000000000000000000000000000000000dead';
const ASSET_DECIMALS = 18;

/** USD per 1 numeraire unit (human), with `decimals` decimals. null = unknown (stale / unreadable feed). */
export type UsdRate = { price: bigint; decimals: number } | null;
export type UsdResolver = (numeraire: string) => Promise<UsdRate>;

export const numeraireSymbol = (n: string) =>
  n.toLowerCase() === USDC.toLowerCase() ? 'USDC' : n.toLowerCase() === WMON.toLowerCase() ? 'MON' : '?';
export const numeraireDecimals = (n: string) =>
  Object.entries(NUMERAIRE_DECIMALS).find(([k]) => k.toLowerCase() === n.toLowerCase())?.[1] ?? 18;

const wad = (v: bigint | null) => (v === null ? null : formatUnits(v, 18));
const toUsd = (priceWad: bigint | null, rate: UsdRate) => (priceWad === null || !rate ? null : mulPrice(priceWad, rate.price, rate.decimals));

// ── Price ──────────────────────────────────────────────────────────────────

/** Last swap price at or before `atS` (default: latest), else the pool's launch price. */
export async function priceAt(db: Db, asset: string, atS?: bigint): Promise<bigint | null> {
  const a = asset.toLowerCase();
  const [s] = await db.select({ p: idxSwaps.priceWad }).from(idxSwaps)
    .where(atS === undefined ? eq(idxSwaps.asset, a) : and(eq(idxSwaps.asset, a), lte(idxSwaps.timestamp, atS)))
    .orderBy(desc(idxSwaps.blockNumber), desc(idxSwaps.logIndex)).limit(1);
  if (s) return BigInt(s.p);
  const [i] = await db.select({ p: idxPoolInits.priceWad, t: idxPoolInits.timestamp }).from(idxPoolInits)
    .where(eq(idxPoolInits.asset, a)).limit(1);
  if (!i || (atS !== undefined && i.t > atS)) return null;
  return BigInt(i.p);
}

/** Circulating supply from indexed transfers: minted − burned (to 0x0 or 0x…dEaD). */
export async function supplyOf(db: Db, asset: string): Promise<bigint> {
  const [r] = await db.select({
    minted: sql<string>`COALESCE(SUM(${idxAssetTransfers.value}) FILTER (WHERE ${idxAssetTransfers.fromAddr} = ${ZERO}), 0)`,
    burned: sql<string>`COALESCE(SUM(${idxAssetTransfers.value}) FILTER (WHERE ${idxAssetTransfers.toAddr} IN (${ZERO}, ${DEAD})), 0)`,
  }).from(idxAssetTransfers).where(eq(idxAssetTransfers.asset, asset.toLowerCase()));
  const minted = BigInt(r?.minted ?? '0');
  return minted === 0n ? TOTAL_SUPPLY : minted - BigInt(r!.burned);
}

export async function marketSnapshot(db: Db, asset: string, numeraire: string, usd: UsdResolver, nowS: bigint) {
  const [price, price24h, supply, rate] = await Promise.all([
    priceAt(db, asset), priceAt(db, asset, nowS - 86_400n), supplyOf(db, asset), usd(numeraire),
  ]);
  // Younger than 24h (no price 24h ago): change since launch.
  const base = price24h ?? (await launchPrice(db, asset));
  const priceUsd = toUsd(price, rate);
  const [v] = await db.select({
    vol: sql<string>`COALESCE(SUM(ABS(${idxSwaps.numeraireDelta})), 0)`,
    n: sql<number>`COUNT(*)::int`,
  }).from(idxSwaps).where(and(eq(idxSwaps.asset, asset.toLowerCase()), sql`${idxSwaps.timestamp} > ${nowS - 86_400n}`));
  const vol24 = BigInt(v?.vol ?? '0');
  const nd = numeraireDecimals(numeraire);
  return {
    numeraire: numeraire.toLowerCase(),
    numeraireSymbol: numeraireSymbol(numeraire),
    price: wad(price),                                  // in numeraire
    priceUsd: wad(priceUsd),
    change24hBps: price === null ? null : changeBps(price, base),
    supply: formatUnits(supply, ASSET_DECIMALS),
    mcapUsd: priceUsd === null ? null : formatUnits((priceUsd * supply) / 10n ** 18n, 18),
    volume24h: formatUnits(vol24, nd),
    volume24hUsd: rate ? formatUnits(mulPrice(vol24 * 10n ** BigInt(18 - nd), rate.price, rate.decimals), 18) : null,
    trades24h: v?.n ?? 0,
    usdPerNumeraire: rate ? formatUnits(rate.price, rate.decimals) : null,
  };
}

async function launchPrice(db: Db, asset: string): Promise<bigint | null> {
  const [i] = await db.select({ p: idxPoolInits.priceWad }).from(idxPoolInits).where(eq(idxPoolInits.asset, asset.toLowerCase())).limit(1);
  return i ? BigInt(i.p) : null;
}

// ── Candles ────────────────────────────────────────────────────────────────

export const TIMEFRAMES = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14_400, '1d': 86_400 } as const;
export type Timeframe = keyof typeof TIMEFRAMES;

export async function candles(db: Db, asset: string, numeraire: string, tf: Timeframe, usd: UsdResolver, limit = 500) {
  const sec = BigInt(TIMEFRAMES[tf]);
  const rows = await db.execute(sql`
    SELECT (${idxSwaps.timestamp} / ${sec}) * ${sec} AS t,
      (array_agg(${idxSwaps.priceWad} ORDER BY ${idxSwaps.blockNumber}, ${idxSwaps.logIndex}))[1] AS o,
      MAX(${idxSwaps.priceWad}) AS h,
      MIN(${idxSwaps.priceWad}) AS l,
      (array_agg(${idxSwaps.priceWad} ORDER BY ${idxSwaps.blockNumber} DESC, ${idxSwaps.logIndex} DESC))[1] AS c,
      SUM(ABS(${idxSwaps.numeraireDelta})) AS v,
      COUNT(*)::int AS n,
      (COUNT(*) FILTER (WHERE ${idxSwaps.isBuyback}))::int AS buybacks
    FROM ${idxSwaps} WHERE ${idxSwaps.asset} = ${asset.toLowerCase()}
    GROUP BY 1 ORDER BY 1 DESC LIMIT ${limit}`);
  const rate = await usd(numeraire);
  const nd = numeraireDecimals(numeraire);
  const list = (rows.rows as Array<Record<string, string | number>>).reverse();
  const px = (x: string | number) => ({ num: wad(BigInt(x))!, usd: wad(toUsd(BigInt(x), rate)) });
  return {
    tf, numeraire: numeraire.toLowerCase(), numeraireSymbol: numeraireSymbol(numeraire),
    usdPerNumeraire: rate ? formatUnits(rate.price, rate.decimals) : null,
    supply: formatUnits(await supplyOf(db, asset), ASSET_DECIMALS),
    launchPrice: wad(await launchPrice(db, asset)),
    candles: list.map((r) => {
      const o = px(r.o!), h = px(r.h!), l = px(r.l!), c = px(r.c!);
      const v = BigInt(r.v!);
      return {
        time: Number(r.t), open: o.num, high: h.num, low: l.num, close: c.num,
        openUsd: o.usd, highUsd: h.usd, lowUsd: l.usd, closeUsd: c.usd,
        volume: formatUnits(v, nd),
        volumeUsd: rate ? formatUnits(mulPrice(v * 10n ** BigInt(18 - nd), rate.price, rate.decimals), 18) : null,
        trades: Number(r.n), buybacks: Number(r.buybacks),
      };
    }),
  };
}

// ── Trades ─────────────────────────────────────────────────────────────────

export async function trades(db: Db, asset: string, numeraire: string, usd: UsdResolver, limit = 50, beforeId?: number) {
  const a = asset.toLowerCase();
  const rows = await db.select().from(idxSwaps)
    .where(beforeId ? and(eq(idxSwaps.asset, a), sql`${idxSwaps.id} < ${beforeId}`) : eq(idxSwaps.asset, a))
    .orderBy(desc(idxSwaps.blockNumber), desc(idxSwaps.logIndex)).limit(limit + 1);
  const rate = await usd(numeraire);
  const nd = numeraireDecimals(numeraire);
  const page = rows.slice(0, limit);
  return {
    numeraireSymbol: numeraireSymbol(numeraire),
    trades: page.map((r) => {
      const assetAmt = BigInt(r.assetDelta), numAmt = BigInt(r.numeraireDelta);
      const absNum = numAmt < 0n ? -numAmt : numAmt;
      return {
        id: r.id,
        side: r.isBuyback ? 'buyback' : assetAmt > 0n ? 'buy' : 'sell',
        isBuyback: r.isBuyback,
        assetAmount: formatUnits(assetAmt < 0n ? -assetAmt : assetAmt, ASSET_DECIMALS),
        numeraireAmount: formatUnits(absNum, nd),
        price: wad(BigInt(r.priceWad)),
        priceUsd: wad(toUsd(BigInt(r.priceWad), rate)),
        valueUsd: rate ? formatUnits(mulPrice(absNum * 10n ** BigInt(18 - nd), rate.price, rate.decimals), 18) : null,
        trader: r.txFrom, sender: r.sender, txHash: r.txHash,
        blockNumber: Number(r.blockNumber), timestamp: Number(r.timestamp),
      };
    }),
    nextBefore: rows.length > limit ? page[page.length - 1]!.id : null,
  };
}

// ── Holders ────────────────────────────────────────────────────────────────

export async function holders(db: Db, asset: string, labels: Record<string, string>, limit = 50) {
  const a = asset.toLowerCase();
  const rows = await db.execute(sql`
    WITH moves AS (
      SELECT ${idxAssetTransfers.toAddr} AS addr, ${idxAssetTransfers.value} AS d FROM ${idxAssetTransfers} WHERE ${idxAssetTransfers.asset} = ${a}
      UNION ALL
      SELECT ${idxAssetTransfers.fromAddr}, -${idxAssetTransfers.value} FROM ${idxAssetTransfers} WHERE ${idxAssetTransfers.asset} = ${a}
    ), bal AS (SELECT addr, SUM(d) AS balance FROM moves WHERE addr NOT IN (${ZERO}, ${DEAD}) GROUP BY addr HAVING SUM(d) > 0)
    SELECT addr, balance, COUNT(*) OVER ()::int AS total FROM bal ORDER BY balance DESC LIMIT ${limit}`);
  const supply = await supplyOf(db, asset);
  const list = rows.rows as Array<{ addr: string; balance: string; total: number }>;
  return {
    holderCount: list[0]?.total ?? 0,
    supply: formatUnits(supply, ASSET_DECIMALS),
    holders: list.map((r) => ({
      address: r.addr,
      label: labels[r.addr] ?? null,
      balance: formatUnits(BigInt(r.balance), ASSET_DECIMALS),
      pctBps: supply === 0n ? 0 : Number((BigInt(r.balance) * 10_000n) / supply),
    })),
  };
}

/** Number of addresses holding a positive balance (for lists / leaderboard). */
export async function holderCount(db: Db, asset: string): Promise<number> {
  return (await holders(db, asset, {}, 1)).holderCount;
}


/**
 * Creator dashboard data (D-MK1) for GET /api/creator/:wallet: the wallet's listed tokens
 * (on-chain creator), claimable trading fees (estimate), escrow claimable (USDC or WMON),
 * vesting releasable, services, recent gateway requests. Chain reads are injected.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { formatUnits } from 'viem';
import { WAD, WMON, isCurrency0 } from '@astralaunch/shared';
import { gatewayRequests, services, tokens } from '../db/schema.js';
import { isListedSql, type Db } from './launchFee.js';
import { numeraireDecimals, numeraireSymbol } from './market.js';

export interface CreatorChain {
  /** Simulated Doppler collectFees(poolId) totals (fees0, fees1) and the wallet's WAD share. */
  tradingFees(poolId: string, wallet: string): Promise<{ fees0: bigint; fees1: bigint; share: bigint }>;
  escrowClaimable(asset: string, wmon: boolean): Promise<bigint>;
  escrowData(asset: string): Promise<{ creator: string; launchTime: number; forfeited: boolean; usdcAccrued: bigint; usdcClaimed: bigint; recordedRevenue: bigint }>;
  vesting(asset: string, wallet: string): Promise<{ total: bigint; released: bigint; releasable: bigint; start: number; cliffS: number; durationS: number }>;
}

const settle = async <T>(p: Promise<T>): Promise<T | null> => { try { return await p; } catch { return null; } };
const fmt18 = (v: bigint) => formatUnits(v, 18);

export async function creatorDashboard(db: Db, chain: CreatorChain, walletRaw: string) {
  const wallet = walletRaw.toLowerCase();
  const own = await db.select().from(tokens)
    .where(and(eq(tokens.creator, wallet), isListedSql(tokens.asset)))
    .orderBy(desc(tokens.launchedAt));

  const svc = own.length === 0 ? [] : await db.select({
    id: services.id, asset: services.asset, slug: services.slug, name: services.name, priceUsdc: services.priceUsdc,
    // Never the upstream link or secrets (public endpoint): those come from the signed POST /api/services/:id/settings.
    timeoutSeconds: services.timeoutSeconds, description: services.description, examplePath: services.examplePath,
    responseKind: services.responseKind, responseContentType: services.responseContentType,
    active: services.active, responseSchema: services.responseSchema, updatedAt: services.updatedAt,
  }).from(services).where(inArray(services.asset, own.map((t) => t.asset)));

  const requests = svc.length === 0 ? [] : await db.select({
    serviceId: gatewayRequests.serviceId, statusCode: gatewayRequests.statusCode, upstreamStatus: gatewayRequests.upstreamStatus,
    latencyMs: gatewayRequests.latencyMs, settled: gatewayRequests.settled, amountUsdc: gatewayRequests.amountUsdc,
    errorCode: gatewayRequests.errorCode, settleTxHash: gatewayRequests.settleTxHash, createdAt: gatewayRequests.createdAt,
  }).from(gatewayRequests).where(inArray(gatewayRequests.serviceId, svc.map((s) => s.id)))
    .orderBy(desc(gatewayRequests.createdAt)).limit(50);

  const tokenCards = await Promise.all(own.map(async (t) => {
    const wmon = t.numeraire.toLowerCase() === WMON.toLowerCase();
    const nd = numeraireDecimals(t.numeraire);
    const [fees, claimable, escrow, vest] = await Promise.all([
      settle(chain.tradingFees(t.poolId, wallet)),
      settle(chain.escrowClaimable(t.asset, wmon)),
      settle(chain.escrowData(t.asset)),
      settle(chain.vesting(t.asset, wallet)),
    ]);
    const assetIs0 = t.numeraire ? isCurrency0(t.asset, t.numeraire) : true;
    const share = fees?.share ?? 0n;
    const numFees = fees ? ((assetIs0 ? fees.fees1 : fees.fees0) * share) / WAD : null;
    const assetFees = fees ? ((assetIs0 ? fees.fees0 : fees.fees1) * share) / WAD : null;
    return {
      asset: t.asset, name: t.name, symbol: t.symbol, imageUrl: t.imageUrl, imageHash: t.imageHash, description: t.description, router: t.router, poolId: t.poolId,
      numeraire: t.numeraire, numeraireSymbol: numeraireSymbol(t.numeraire), launchedAt: t.launchedAt,
      tradingFees: fees === null ? null : {
        estimated: true, shareWad: share.toString(),
        numeraire: formatUnits(numFees!, nd), asset: fmt18(assetFees!),
      },
      escrow: escrow === null ? null : {
        claimable: claimable === null ? null : formatUnits(claimable, wmon ? 18 : 6),
        claimableSymbol: wmon ? 'WMON' : 'USDC',
        usdcAccrued: formatUnits(escrow.usdcAccrued, 6), usdcClaimed: formatUnits(escrow.usdcClaimed, 6),
        recordedRevenue: formatUnits(escrow.recordedRevenue, 6), forfeited: escrow.forfeited,
        launchTime: escrow.launchTime, forfeitAt: escrow.launchTime + 365 * 86_400,
      },
      vesting: vest === null ? null : {
        total: fmt18(vest.total), released: fmt18(vest.released), releasable: fmt18(vest.releasable),
        locked: fmt18(vest.total - vest.released - vest.releasable),
        start: vest.start, cliffEnd: vest.start + vest.cliffS, end: vest.start + vest.durationS,
      },
    };
  }));

  const svcById = new Map(svc.map((s) => [s.id, s]));
  return {
    wallet,
    tokens: tokenCards,
    services: svc.map((s) => ({ ...s, hasResponseSchema: !!s.responseSchema, responseSchema: undefined })),
    recentRequests: requests.map((r) => ({
      service: svcById.get(r.serviceId)?.slug ?? null,
      statusCode: r.statusCode, upstreamStatus: r.upstreamStatus, latencyMs: r.latencyMs,
      charged: r.settled, amountUsdc: formatUnits(BigInt(r.amountUsdc), 6),
      errorCode: r.errorCode, settleTxHash: r.settleTxHash, createdAt: r.createdAt,
    })),
  };
}

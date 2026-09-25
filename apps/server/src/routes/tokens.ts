/**
 * Token API routes — /api/tokens
 *
 * GET  /api/tokens               — explore list (sort=clean_revenue_30d|new)
 * POST /api/tokens               — creator-signed metadata update (tokens come from the indexer)
 * GET  /api/tokens/:asset        — aggregated token + service + on-chain state
 * GET  /api/tokens/:asset/payments — recent settled payments
 * GET  /api/tokens/:asset/health   — service probe uptime data
 * GET  /api/tokens/:asset/candles  — OHLC (tf=5m|15m|1h|4h|1d), USD for MON pairs via Chainlink
 * GET  /api/tokens/:asset/trades   — swaps (buybacks marked)
 * GET  /api/tokens/:asset/holders  — holder balances
 *
 * All GETs only expose listed tokens (launch fee paid + consumed, D-LF4).
 */
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, desc, and, gte, sql, count, or, isNull, lt } from 'drizzle-orm';
import { createPublicClient, formatUnits, http, type Address } from 'viem';
import { defineChain } from 'viem';
import { db } from '../db/client.js';
import {
  tokens, services, gatewayRequests, serviceProbes,
  idxRegistrations, idxDistributions, idxBuybacks, idxEscrowClaims,
  idxEscrowForfeits, idxUsdcTransfers, idxCheckpoints,
} from '../db/schema.js';
import { tokenMetadataSchema, tokenMetadataMessage, WMON } from '@astralaunch/shared';
import { authorizeTokenCreator, consumeSignedMessage, ServiceAuthError } from '../services/serviceAuth.js';
import { RPC_URL, CHAIN_ID, REGISTRY_ADDR, SUBMITTERS } from '../env.js';
import { isAssetListed, isListedSql } from '../services/launchFee.js';
import { classifyTransfer, excludedPayers } from '../services/cleanRevenue.js';
import { platformAddrs } from '../lib/platform.js';
import { creatorChain, holderLabels, usdResolver, vaultAssetData } from '../lib/chain.js';
import { classifiedPayments, isVerified, serviceHealth, sparkline7d, usageSummary } from '../services/usage.js';
import { holderCount } from '../services/market.js';
import { TIMEFRAMES, candles, holders, marketSnapshot, trades, type Timeframe } from '../services/market.js';

// ── viem client ───────────────────────────────────────────────────────────────

const monad = defineChain({
  id: CHAIN_ID,
  name: 'Monad',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const publicClient = createPublicClient({ chain: monad, transport: http(RPC_URL) });

// ── Minimal ABIs for on-chain reads ──────────────────────────────────────────

const escrowAbi = [
  { type: 'function', name: 'claimable', stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'tokenData', stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{ type: 'tuple', components: [
      { name: 'creator',         type: 'address' },
      { name: 'launchTime',      type: 'uint48'  },
      { name: 'forfeited',       type: 'bool'    },
      { name: 'usdcAccrued',     type: 'uint128' },
      { name: 'usdcClaimed',     type: 'uint128' },
      { name: 'tokenPending',    type: 'uint128' },
      { name: 'recordedRevenue', type: 'uint128' },
      { name: 'poolId',          type: 'bytes32' },
    ]}],
  },
] as const;


const erc20Abi = [
  { type: 'function', name: 'name',     stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'symbol',   stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'balanceLimitEnd', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint48' }] },
  // DopplerERC20V1 vesting
  { type: 'function', name: 'vestingStart', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint48' }] },
  { type: 'function', name: 'totalAllocatedOf', stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'vestedAmount', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }, { name: 'timestamp', type: 'uint256' }],
    outputs: [{ type: 'uint256' }] },
] as const;


// Env-injected singleton addresses (populated from env in env.ts)
import { ESCROW_ADDR, VAULT_ADDR } from '../env.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const nowS = () => BigInt(Math.floor(Date.now() / 1000));

/** Token page "Creator" box: escrow unlocked vs collected, vesting progress, escrow expiry. */
async function creatorSummary(t: { asset: string; creator: string; numeraire: string }) {
  const wmon = t.numeraire.toLowerCase() === WMON.toLowerCase();
  const safe = async <T,>(p: Promise<T>) => { try { return await p; } catch { return null; } };
  const [escrow, claimable, vest] = await Promise.all([
    safe(creatorChain.escrowData(t.asset)), safe(creatorChain.escrowClaimable(t.asset, wmon)), safe(creatorChain.vesting(t.asset, t.creator)),
  ]);
  const f6 = (v: bigint) => formatUnits(v, 6);
  const f18 = (v: bigint) => formatUnits(v, 18);
  return {
    escrow: escrow ? {
      symbol: wmon ? 'WMON' : 'USDC',
      claimable: claimable === null ? null : wmon ? f18(claimable) : f6(claimable),
      usdcAccrued: f6(escrow.usdcAccrued), usdcClaimed: f6(escrow.usdcClaimed),
      recordedRevenue: f6(escrow.recordedRevenue), forfeitAt: escrow.launchTime + 365 * 86_400, forfeited: escrow.forfeited,
    } : null,
    vesting: vest ? { total: f18(vest.total), vested: f18(vest.released + vest.releasable), start: vest.start, cliffEnd: vest.start + vest.cliffS, end: vest.start + vest.durationS } : null,
  };
}

function ago(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

/** Compute clean revenue from gateway_requests for the given asset in the last N days. */
async function cleanRevenue(asset: string, days: number): Promise<bigint> {
  const since = ago(days);
  const rows = await db.select({
    amountUsdc: gatewayRequests.amountUsdc,
    payer:      gatewayRequests.payer,
    txHash:     gatewayRequests.settleTxHash,
  })
    .from(gatewayRequests)
    .where(and(
      eq(gatewayRequests.asset,    asset),
      eq(gatewayRequests.settled,  true),
      gte(gatewayRequests.createdAt, since),
    ));

  // A clean payment: settlement tx submitted by allowlisted facilitator address.
  // For now we filter by having a settleTxHash (indicates it went through facilitator).
  // Full wash filtering (hop check, payer age) is display-only (SPEC §13) and skipped here.
  let total = 0n;
  for (const r of rows) {
    // In production, cross-reference settleTxHash with SUBMITTERS list.
    // For hackathon, any settled request with a tx hash is treated as clean.
    if (r.txHash) total += BigInt(r.amountUsdc);
  }
  return total;
}

// ── Routes ────────────────────────────────────────────────────────────────────

const app = new Hono();

// Unlisted tokens (no consumed launch fee) do not exist publicly (D-LF4).
const requireListed = async (c: any, next: () => Promise<void>) => {
  if (!(await isAssetListed(db, c.req.param('asset')))) {
    return c.json({ error: 'Token not found' }, 404);
  }
  await next();
};
app.get('/:asset', requireListed);
app.get('/:asset/*', requireListed);

// GET /api/tokens?sort=clean_revenue_30d|new&limit=50&offset=0
app.get('/', async (c) => {
  const sort   = c.req.query('sort') ?? 'clean_revenue_30d';
  // Usage window for usage30d (Discover range switch): 7, 30 (default) or 90 days.
  const days   = [7, 30, 90].includes(Number(c.req.query('days'))) ? BigInt(Number(c.req.query('days'))) : 30n;
  const limit  = Math.min(Number(c.req.query('limit') ?? 50), 100);
  const offset = Number(c.req.query('offset') ?? 0);

  const since30 = ago(30);

  // Aggregate clean revenue per asset from gateway_requests
  const revenueRows = await db
    .select({
      asset:   gatewayRequests.asset,
      revenue: sql<string>`COALESCE(SUM(CASE WHEN ${gatewayRequests.settled} AND ${gatewayRequests.settleTxHash} IS NOT NULL THEN CAST(${gatewayRequests.amountUsdc} AS NUMERIC) ELSE 0 END), 0)`.as('revenue'),
      calls:   sql<number>`COUNT(*)`.as('calls'),
    })
    .from(gatewayRequests)
    .where(gte(gatewayRequests.createdAt, since30))
    .groupBy(gatewayRequests.asset);

  const revenueMap = new Map(revenueRows.map(r => [r.asset, { revenue: BigInt(r.revenue), calls: r.calls }]));

  // Only tokens whose launch fee was paid and consumed are public (D-LF4).
  const allTokens = await db.select().from(tokens)
    .where(isListedSql(tokens.asset))
    .orderBy(sort === 'new' ? desc(tokens.launchedAt) : desc(tokens.launchedAt))
    .limit(limit)
    .offset(offset);

  // Attach active service + revenue metrics
  const results = await Promise.all(allTokens.map(async (t) => {
    const svc = await db.query.services.findFirst({
      where: and(eq(services.asset, t.asset), eq(services.active, true)),
    });
    const metrics = revenueMap.get(t.asset) ?? { revenue: 0n, calls: 0 };
    const market = t.numeraire ? await marketSnapshot(db, t.asset, t.numeraire, usdResolver, nowS()) : null;
    const trend = t.numeraire ? await sparkline7d(db, t.asset, nowS()) : null;
    const usage30d = t.numeraire ? await usageSummary(db, t, nowS() - days * 86_400n, usdResolver, platformAddrs()) : null;
    const usageAll = t.numeraire ? await usageSummary(db, t, null, usdResolver, platformAddrs()) : null;
    return {
      asset:         t.asset,
      name:          t.name,
      symbol:        t.symbol,
      creator:       t.creator,
      router:        t.router,
      imageUrl:      t.imageUrl,
      launchedAt:    t.launchedAt,
      service: svc ? {
        slug:        svc.slug,
        name:        svc.name,
        description: svc.description,
        priceUsdc:   svc.priceUsdc,
        endpoint:    `/s/${svc.slug}`,
      } : null,
      metrics: {
        cleanRevenue30d: metrics.revenue.toString(),
        calls30d:        metrics.calls,
      },
      market: market && trend ? { ...market, ...trend } : market,
      usage30d,
      usageDays:     Number(days),
      verified:      isVerified(usageAll),
      holders:       await holderCount(db, t.asset),
      xHandle:       t.xHandle,
      description:   t.description,
    };
  }));

  // Sort by revenue if requested
  if (sort === 'clean_revenue_30d') {
    results.sort((a, b) => {
      const diff = BigInt(b.metrics.cleanRevenue30d) - BigInt(a.metrics.cleanRevenue30d);
      return diff > 0n ? 1 : diff < 0n ? -1 : 0;
    });
  }

  return c.json({ tokens: results, limit, offset });
});

// POST /api/tokens — metadata only (image, X handle, website, description), signed by
// the token's on-chain creator (same JSON signed-message + replay protection as services,
// D-SV1). Token rows are created by the indexer from the Registered
// event (D-TK1); this cannot create a token that is not registered on-chain.
app.post('/', zValidator('json', tokenMetadataSchema), async (c) => {
  const body = c.req.valid('json');
  const asset = body.asset.toLowerCase();

  const { signature, ...signed } = body;
  const message = tokenMetadataMessage(signed);
  const existing = await db.query.tokens.findFirst({ where: eq(tokens.asset, asset) });

  try {
    const token = await authorizeTokenCreator(db, {
      asset, message, signature, issuedAt: body.issuedAt, nowS: Math.floor(Date.now() / 1000),
      lastIssuedAt: existing?.metadataSignedAt ?? null, requireListed: false,
    });
    await db.transaction(async (tx) => {
      await consumeSignedMessage(tx, message, token.creator, 'token_metadata', body.issuedAt);
      const [row] = await tx.update(tokens).set({
        ...(body.imageUrl    !== undefined && { imageUrl:    body.imageUrl }),
        ...(body.xHandle     !== undefined && { xHandle:     body.xHandle.replace(/^@/, '') }),
        ...(body.website     !== undefined && { website:     body.website }),
        ...(body.description !== undefined && { description: body.description }),
        metadataSignedAt: BigInt(body.issuedAt),
      })
        // Monotonic guard against a concurrent, older signed update.
        .where(and(eq(tokens.asset, asset),
          or(isNull(tokens.metadataSignedAt), lt(tokens.metadataSignedAt, BigInt(body.issuedAt)))))
        .returning({ asset: tokens.asset });
      if (!row) throw new ServiceAuthError(409, 'A newer signed request was already accepted (issuedAt too old)');
    });
  } catch (e) {
    if (e instanceof ServiceAuthError) return c.json({ error: e.message }, e.status);
    throw e;
  }

  return c.json({ asset, updated: true });
});

// GET /api/tokens/:asset — full token detail
app.get('/:asset', async (c) => {
  const asset = c.req.param('asset').toLowerCase();

  const token = await db.query.tokens.findFirst({ where: eq(tokens.asset, asset) });
  if (!token) return c.json({ error: 'Token not found' }, 404);

  const svc = await db.query.services.findFirst({
    where: and(eq(services.asset, asset), eq(services.active, true)),
  });

  // Revenue metrics from DB
  const since24 = ago(1);
  const since7  = ago(7);
  const since30 = ago(30);

  const [rev24, rev7, rev30] = await Promise.all([
    cleanRevenue(asset, 1),
    cleanRevenue(asset, 7),
    cleanRevenue(asset, 30),
  ]);

  // Distinct payers (30d)
  const [payersRow] = await db
    .select({ cnt: sql<number>`COUNT(DISTINCT ${gatewayRequests.payer})` })
    .from(gatewayRequests)
    .where(and(
      eq(gatewayRequests.asset,   asset),
      eq(gatewayRequests.settled, true),
      gte(gatewayRequests.createdAt, since30),
    ));

  // On-chain reads (non-fatal — return nulls on error)
  let escrowData: any = null;
  let vaultData:  any = null;
  let capEnd: number | null = null;

  try {
    escrowData = await publicClient.readContract({
      address: ESCROW_ADDR, abi: escrowAbi, functionName: 'tokenData', args: [asset as Address],
    });
  } catch { /* ignore */ }

  try {
    vaultData = await vaultAssetData(asset);   // v2 layout (the old v1 ABI never decoded)
  } catch { /* ignore */ }

  try {
    capEnd = await publicClient.readContract({
      address: asset as Address,
      abi: [{ type: 'function', name: 'balanceLimitEnd', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint48' }] }] as const,
      functionName: 'balanceLimitEnd',
    });
  } catch { /* ignore */ }

  return c.json({
    asset:      token.asset,
    name:       token.name,
    symbol:     token.symbol,
    creator:    token.creator,
    router:     token.router,
    imageUrl:   token.imageUrl,
    description:token.description,
    website:    token.website,
    twitter:    token.twitter,
    xHandle:    token.xHandle,
    launchedAt: token.launchedAt,
    launcher:   token.launcher,
    poolId:     token.poolId,
    numeraire:  token.numeraire,
    decimals:   token.decimals,
    registeredBlock: token.registeredBlock?.toString() ?? null,
    market: token.numeraire ? { ...(await marketSnapshot(db, token.asset, token.numeraire, usdResolver, nowS())), ...(await sparkline7d(db, token.asset, nowS())) } : null,
    usage30d: token.numeraire ? await usageSummary(db, token, nowS() - 30n * 86_400n, usdResolver, platformAddrs()) : null,
    usageAll: token.numeraire ? await usageSummary(db, token, null, usdResolver, platformAddrs()) : null,
    serviceHealth: svc ? await serviceHealth(db, svc.id) : null,
    serviceUpdatedAt: svc?.updatedAt ?? null,
    holders: await holderCount(db, token.asset),
    verified: isVerified(token.numeraire ? await usageSummary(db, token, null, usdResolver, platformAddrs()) : null),
    creatorSummary: await creatorSummary(token),
    service: svc ? {
      id:            svc.id,
      slug:          svc.slug,
      name:          svc.name,
      description:   svc.description,
      priceUsdc:     svc.priceUsdc,
      requestSchema: svc.requestSchema,
      responseSchema:svc.responseSchema,
      endpoint:      `/s/${svc.slug}`,
    } : null,
    metrics: {
      cleanRevenue24h:  rev24.toString(),
      cleanRevenue7d:   rev7.toString(),
      cleanRevenue30d:  rev30.toString(),
      cleanPayers30d:   payersRow?.cnt ?? 0,
    },
    onChain: {
      escrow: escrowData ? {
        usdcAccrued:     escrowData.usdcAccrued.toString(),
        usdcClaimed:     escrowData.usdcClaimed.toString(),
        recordedRevenue: escrowData.recordedRevenue.toString(),
        forfeited:       escrowData.forfeited,
        launchTime:      Number(escrowData.launchTime),
        forfeitAt:       Number(escrowData.launchTime) + 365 * 86400,
      } : null,
      buyback: vaultData ? {
        balanceUsdc:        vaultData.balanceUSDC.toString(),
        buybackFromRevenue: vaultData.buybackFromRevenue.toString(),
        buybackFromTrading: vaultData.buybackFromTrading.toString(),
        lastExecuteTime:    Number(vaultData.lastExecuteTime),
      } : null,
      balanceLimitEnd: capEnd !== null ? Number(capEnd) : null,
    },
  });
});

// GET /api/tokens/:asset/metrics — aggregated on-chain metrics from indexed data
// Clean revenue filtering per SPEC §13
app.get('/:asset/metrics', async (c) => {
  const asset = c.req.param('asset').toLowerCase();

  const [distRows] = await db
    .select({
      totalRevenue:    sql<string>`COALESCE(SUM(${idxDistributions.total}), '0')`,
      totalCount:      sql<number>`COUNT(*)::int`,
      providerRevenue: sql<string>`COALESCE(SUM(${idxDistributions.providerAmt}), '0')`,
      buybackRevenue:  sql<string>`COALESCE(SUM(${idxDistributions.buybackAmt}), '0')`,
      treasuryRevenue: sql<string>`COALESCE(SUM(${idxDistributions.treasuryAmt}), '0')`,
    })
    .from(idxDistributions)
    .where(eq(idxDistributions.asset, asset));

  const [buybackRows] = await db
    .select({
      totalUsdc:   sql<string>`COALESCE(SUM(${idxBuybacks.usdcIn}), '0')`,
      totalBurned: sql<string>`COALESCE(SUM(${idxBuybacks.tokensBurned}), '0')`,
    })
    .from(idxBuybacks)
    .where(eq(idxBuybacks.asset, asset));

  const [claimRows] = await db
    .select({
      totalClaimed: sql<string>`COALESCE(SUM(${idxEscrowClaims.amount}), '0')`,
    })
    .from(idxEscrowClaims)
    .where(eq(idxEscrowClaims.asset, asset));

  const [forfeitRows] = await db
    .select({
      totalForfeited: sql<string>`COALESCE(SUM(${idxEscrowForfeits.usdcMoved}), '0')`,
    })
    .from(idxEscrowForfeits)
    .where(eq(idxEscrowForfeits.asset, asset));

  // Find the token record + registration for this asset
  const token = await db.query.tokens.findFirst({ where: eq(tokens.asset, asset) });

  // Look up registration to get creator address (from on-chain data)
  const [registration] = await db.select({
    creator: idxRegistrations.creator,
    router:  idxRegistrations.router,
  })
    .from(idxRegistrations)
    .where(eq(idxRegistrations.asset, asset))
    .limit(1);

  const routerAddr = (registration?.router ?? token?.router ?? '').toLowerCase();
  const creatorAddr = (registration?.creator ?? token?.creator ?? '').toLowerCase();

  // Clean-revenue rules live in services/cleanRevenue.ts (shared with /api/leaderboard).
  const excludedAddrs = excludedPayers(routerAddr, platformAddrs());

  // Query all USDC transfers to this router
  let rawRevenue = 0n;
  let cleanRevenue = 0n;
  let transferCount = 0;
  const exclusions: { payer: string; amount: string; reason: string }[] = [];

  if (routerAddr) {
    const transfers = await db.select({
      fromAddr:             idxUsdcTransfers.fromAddr,
      value:                idxUsdcTransfers.value,
      isFacilitatorSettled: idxUsdcTransfers.isFacilitatorSettled,
    })
      .from(idxUsdcTransfers)
      .where(eq(idxUsdcTransfers.toAddr, routerAddr));

    transferCount = transfers.length;

    for (const t of transfers) {
      const val = BigInt(t.value);
      rawRevenue += val;
      const cls = classifyTransfer(t, creatorAddr, excludedAddrs);
      if (cls !== 'clean') {
        exclusions.push({ payer: t.fromAddr, amount: t.value, reason: cls });
        continue;
      }

      // TODO: "funded by creator" detection — check if payer received USDC from
      // creator in the same block or recent blocks. Requires additional hop analysis.

      cleanRevenue += val;
    }
  }

  // Last indexed block from checkpoints
  const checkpoints = await db.select().from(idxCheckpoints);
  const lastBlock = checkpoints.reduce(
    (max, cp) => (cp.blockNumber > max ? cp.blockNumber : max),
    0n,
  );

  return c.json({
    totalRevenue:       distRows?.totalRevenue ?? '0',
    totalDistributions: distRows?.totalCount ?? 0,
    providerRevenue:    distRows?.providerRevenue ?? '0',
    buybackRevenue:     distRows?.buybackRevenue ?? '0',
    treasuryRevenue:    distRows?.treasuryRevenue ?? '0',
    totalBuybackUsdc:   buybackRows?.totalUsdc ?? '0',
    totalTokensBurned:  buybackRows?.totalBurned ?? '0',
    escrowClaimed:      claimRows?.totalClaimed ?? '0',
    escrowForfeited:    forfeitRows?.totalForfeited ?? '0',
    rawRevenue:         rawRevenue.toString(),
    cleanRevenue:       cleanRevenue.toString(),
    exclusions,
    usdcTransferCount:  transferCount,
    usdcTransferTotal:  rawRevenue.toString(),
    lastIndexedBlock:   Number(lastBlock),
  });
});

// GET /api/tokens/:asset/payments — recent settled payments
// ?source=indexed reads from idx_usdc_transfers instead of gateway_requests
app.get('/:asset/payments', async (c) => {
  const asset  = c.req.param('asset').toLowerCase();
  const source = c.req.query('source');
  const limit  = Math.min(Number(c.req.query('limit') ?? 20), 100);
  const offset = Number(c.req.query('offset') ?? 0);

  if (source === 'classified') {
    const token = await db.query.tokens.findFirst({ where: eq(tokens.asset, asset) });
    if (!token?.router) return c.json({ payments: [], limit, offset });
    return c.json({ payments: await classifiedPayments(db, token, platformAddrs(), limit), limit, offset });
  }

  if (source === 'indexed') {
    // Read from indexed USDC transfers
    const token = await db.query.tokens.findFirst({ where: eq(tokens.asset, asset) });
    if (!token?.router) return c.json({ payments: [], limit, offset });

    const rows = await db.select()
      .from(idxUsdcTransfers)
      .where(eq(idxUsdcTransfers.toAddr, token.router.toLowerCase()))
      .orderBy(desc(idxUsdcTransfers.blockNumber))
      .limit(limit)
      .offset(offset);

    return c.json({
      payments: rows.map(r => ({
        fromAddr:             r.fromAddr,
        toAddr:               r.toAddr,
        amountUsdc:           r.value,
        txHash:               r.txHash,
        txFrom:               r.txFrom,
        isFacilitatorSettled: r.isFacilitatorSettled,
        blockNumber:          Number(r.blockNumber),
        timestamp:            Number(r.timestamp),
      })),
      limit,
      offset,
    });
  }

  // Default: read from gateway_requests
  const rows = await db.select()
    .from(gatewayRequests)
    .where(and(eq(gatewayRequests.asset, asset), eq(gatewayRequests.settled, true)))
    .orderBy(desc(gatewayRequests.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json({
    payments: rows.map(r => ({
      id:          r.id,
      payer:       r.payer,
      amountUsdc:  r.amountUsdc,
      txHash:      r.settleTxHash,
      latencyMs:   r.latencyMs,
      createdAt:   r.createdAt,
    })),
    limit,
    offset,
  });
});

// GET /api/tokens/:asset/buybacks — paginated buyback events from indexed data
app.get('/:asset/buybacks', async (c) => {
  const asset = c.req.param('asset').toLowerCase();
  const limit = Math.min(Number(c.req.query('limit') ?? 20), 100);
  const offset = Number(c.req.query('offset') ?? 0);

  const rows = await db.select()
    .from(idxBuybacks)
    .where(eq(idxBuybacks.asset, asset))
    .orderBy(desc(idxBuybacks.blockNumber))
    .limit(limit + 1) // fetch one extra to determine if there's a next page
    .offset(offset);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  return c.json({
    buybacks: items.map(r => ({
      usdcIn:       r.usdcIn,
      tokensBurned: r.tokensBurned,
      sourceTag:    r.sourceTag,
      blockNumber:  Number(r.blockNumber),
      txHash:       r.txHash,
      timestamp:    Number(r.timestamp),
    })),
    cursor: hasMore ? String(offset + limit) : null,
  });
});

// GET /api/tokens/:asset/candles?tf=5m|15m|1h|4h|1d — OHLC from indexed v4 swaps (D-MK1)
app.get('/:asset/candles', zValidator('query', z.object({
  tf: z.enum(Object.keys(TIMEFRAMES) as [Timeframe, ...Timeframe[]]).default('1h'),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
})), async (c) => {
  const token = await db.query.tokens.findFirst({ where: eq(tokens.asset, c.req.param('asset').toLowerCase()) });
  if (!token?.numeraire) return c.json({ error: 'Token not indexed yet' }, 404);
  const { tf, limit } = c.req.valid('query');
  return c.json(await candles(db, token.asset, token.numeraire, tf, usdResolver, limit));
});

// GET /api/tokens/:asset/trades?limit&before — swaps, newest first; buybacks marked
app.get('/:asset/trades', zValidator('query', z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().positive().optional(),
})), async (c) => {
  const token = await db.query.tokens.findFirst({ where: eq(tokens.asset, c.req.param('asset').toLowerCase()) });
  if (!token?.numeraire) return c.json({ error: 'Token not indexed yet' }, 404);
  const { limit, before } = c.req.valid('query');
  return c.json(await trades(db, token.asset, token.numeraire, usdResolver, limit, before));
});

// GET /api/tokens/:asset/holders?limit — balances from indexed transfers, labeled
app.get('/:asset/holders', zValidator('query', z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
})), async (c) => {
  const token = await db.query.tokens.findFirst({ where: eq(tokens.asset, c.req.param('asset').toLowerCase()) });
  if (!token) return c.json({ error: 'Token not found' }, 404);
  return c.json(await holders(db, token.asset, holderLabels(token.creator, token.asset), c.req.valid('query').limit));
});

// GET /api/tokens/:asset/health — service probe uptime
app.get('/:asset/health', async (c) => {
  const asset  = c.req.param('asset').toLowerCase();
  const window = Number(c.req.query('windowHours') ?? 168); // default 7 days

  const svc = await db.query.services.findFirst({
    where: and(eq(services.asset, asset), eq(services.active, true)),
  });
  if (!svc) return c.json({ uptime: null, message: 'No active service' });

  const since = new Date(Date.now() - window * 3600_000);
  const [total, ok] = await Promise.all([
    db.select({ cnt: count() }).from(serviceProbes)
      .where(and(eq(serviceProbes.serviceId, svc.id), gte(serviceProbes.checkedAt, since))),
    db.select({ cnt: count() }).from(serviceProbes)
      .where(and(eq(serviceProbes.serviceId, svc.id), gte(serviceProbes.checkedAt, since), eq(serviceProbes.ok, true))),
  ]);

  const totalCnt = total[0]?.cnt ?? 0;
  const okCnt    = ok[0]?.cnt ?? 0;
  const uptime   = totalCnt > 0 ? okCnt / totalCnt : null;

  // Recent probes (last 10)
  const recent = await db.select().from(serviceProbes)
    .where(eq(serviceProbes.serviceId, svc.id))
    .orderBy(desc(serviceProbes.checkedAt))
    .limit(10);

  return c.json({
    uptime,
    totalChecks:  totalCnt,
    windowHours:  window,
    recentProbes: recent.map(p => ({
      ok:        p.ok,
      latencyMs: p.latencyMs,
      status:    p.statusCode,
      checkedAt: p.checkedAt,
    })),
  });
});

export default app;

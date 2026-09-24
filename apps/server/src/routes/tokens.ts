/**
 * Token API routes — /api/tokens
 *
 * GET  /api/tokens               — explore list (sort=clean_revenue_30d|new)
 * POST /api/tokens               — record a newly launched token
 * GET  /api/tokens/:asset        — aggregated token + service + on-chain state
 * GET  /api/tokens/:asset/payments — recent settled payments
 * GET  /api/tokens/:asset/health   — service probe uptime data
 */
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, desc, and, gte, sql, count } from 'drizzle-orm';
import { createPublicClient, http, type Address } from 'viem';
import { defineChain } from 'viem';
import { db } from '../db/client.js';
import {
  tokens, services, gatewayRequests, serviceProbes,
  idxDistributions, idxBuybacks, idxEscrowClaims, idxEscrowForfeits,
  idxUsdcTransfers, idxCheckpoints,
} from '../db/schema.js';
import { addressSchema } from '@revpad/shared';
import { RPC_URL, CHAIN_ID, REGISTRY_ADDR, SUBMITTERS } from '../env.js';

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

const vaultAbi = [
  { type: 'function', name: 'assetData', stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{ type: 'tuple', components: [
      { name: 'poolKey', type: 'tuple', components: [
        { name: 'currency0',   type: 'address' },
        { name: 'currency1',   type: 'address' },
        { name: 'fee',         type: 'uint24'  },
        { name: 'tickSpacing', type: 'int24'   },
        { name: 'hooks',       type: 'address' },
      ]},
      { name: 'poolId',             type: 'bytes32' },
      { name: 'registered',         type: 'bool'    },
      { name: 'balanceUSDC',        type: 'uint128' },
      { name: 'buybackFromRevenue', type: 'uint128' },
      { name: 'buybackFromTrading', type: 'uint128' },
      { name: 'tokenBalance',       type: 'uint128' },
      { name: 'lastExecuteTime',    type: 'uint64'  },
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

const registryAbi = [
  { type: 'function', name: 'routers', stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'address' }] },
] as const;

// Env-injected singleton addresses (populated from env in env.ts)
import { ESCROW_ADDR, VAULT_ADDR } from '../env.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// GET /api/tokens?sort=clean_revenue_30d|new&limit=50&offset=0
app.get('/', async (c) => {
  const sort   = c.req.query('sort') ?? 'clean_revenue_30d';
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

  const allTokens = await db.select().from(tokens)
    .orderBy(sort === 'new' ? desc(tokens.launchedAt) : desc(tokens.launchedAt))
    .limit(limit)
    .offset(offset);

  // Attach active service + revenue metrics
  const results = await Promise.all(allTokens.map(async (t) => {
    const svc = await db.query.services.findFirst({
      where: and(eq(services.asset, t.asset), eq(services.active, true)),
    });
    const metrics = revenueMap.get(t.asset) ?? { revenue: 0n, calls: 0 };
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
      } : null,
      metrics: {
        cleanRevenue30d: metrics.revenue.toString(),
        calls30d:        metrics.calls,
      },
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

// POST /api/tokens — record a newly launched token (called after SDK launch + registry.register)
const createTokenSchema = z.object({
  asset:       addressSchema,
  name:        z.string().min(1).max(80),
  symbol:      z.string().min(1).max(20),
  imageUrl:    z.string().url().optional(),
  description: z.string().max(500).optional(),
  website:     z.string().url().optional(),
  twitter:     z.string().url().optional(),
});

app.post('/', zValidator('json', createTokenSchema), async (c) => {
  const body = c.req.valid('json');
  const assetAddr = body.asset.toLowerCase() as Address;

  // Verify on-chain that this asset is registered in RevpadRegistry
  let router: Address;
  try {
    router = await publicClient.readContract({
      address: REGISTRY_ADDR,
      abi:     registryAbi,
      functionName: 'routers',
      args:    [assetAddr],
    });
    if (router === '0x0000000000000000000000000000000000000000') {
      return c.json({ error: 'Asset not registered in RevpadRegistry' }, 400);
    }
  } catch {
    return c.json({ error: 'Failed to read RevpadRegistry' }, 502);
  }

  // Read creator from FeeEscrow tokenData (populated by register)
  let creator: string;
  try {
    const data = await publicClient.readContract({
      address: ESCROW_ADDR,
      abi:     escrowAbi,
      functionName: 'tokenData',
      args:    [assetAddr],
    });
    creator = data.creator.toLowerCase();
  } catch {
    return c.json({ error: 'Failed to read FeeEscrow' }, 502);
  }

  // Upsert token record
  await db.insert(tokens).values({
    asset:       assetAddr,
    name:        body.name,
    symbol:      body.symbol,
    creator,
    router:      router.toLowerCase(),
    imageUrl:    body.imageUrl,
    description: body.description,
    website:     body.website,
    twitter:     body.twitter,
  }).onConflictDoUpdate({
    target:  tokens.asset,
    set: {
      name:        body.name,
      symbol:      body.symbol,
      imageUrl:    body.imageUrl,
      description: body.description,
      website:     body.website,
      twitter:     body.twitter,
    },
  });

  return c.json({ asset: assetAddr, router: router.toLowerCase() }, 201);
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
    vaultData = await publicClient.readContract({
      address: VAULT_ADDR, abi: vaultAbi, functionName: 'assetData', args: [asset as Address],
    });
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
    launchedAt: token.launchedAt,
    service: svc ? {
      id:            svc.id,
      slug:          svc.slug,
      name:          svc.name,
      description:   svc.description,
      priceUsdc:     svc.priceUsdc,
      requestSchema: svc.requestSchema,
      responseSchema:svc.responseSchema,
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

  // Find the router for this asset to query USDC transfers
  const token = await db.query.tokens.findFirst({ where: eq(tokens.asset, asset) });
  let usdcCount = 0;
  let usdcTotal = '0';
  if (token?.router) {
    const [usdcRows] = await db
      .select({
        cnt:   sql<number>`COUNT(*)::int`,
        total: sql<string>`COALESCE(SUM(${idxUsdcTransfers.value}), '0')`,
      })
      .from(idxUsdcTransfers)
      .where(eq(idxUsdcTransfers.toAddr, token.router.toLowerCase()));
    usdcCount = usdcRows?.cnt ?? 0;
    usdcTotal = usdcRows?.total ?? '0';
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
    usdcTransferCount:  usdcCount,
    usdcTransferTotal:  usdcTotal,
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

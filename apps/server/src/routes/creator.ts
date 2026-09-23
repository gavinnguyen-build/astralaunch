/**
 * Creator dashboard — GET /api/creator/me
 *
 * Returns all tokens + services owned by the authenticated creator wallet.
 * Auth: Privy JWT — `X-Privy-Token` header → decoded to wallet address.
 *
 * For the hackathon, auth is simplified: `X-Creator-Address` header (wallet address).
 * Full Privy JWT verification to be added before mainnet.
 */
import { Hono } from 'hono';
import { eq, and, gte, sql, desc } from 'drizzle-orm';
import { createPublicClient, http, type Address } from 'viem';
import { defineChain } from 'viem';
import { db } from '../db/client.js';
import { tokens, services, gatewayRequests } from '../db/schema.js';
import { RPC_URL, CHAIN_ID, ESCROW_ADDR, VAULT_ADDR } from '../env.js';

const monad = defineChain({
  id: CHAIN_ID,
  name: 'Monad',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const publicClient = createPublicClient({ chain: monad, transport: http(RPC_URL) });

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

// DopplerERC20V1 vesting
const vestingAbi = [
  { type: 'function', name: 'totalAllocatedOf', stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'vestedAmount', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }, { name: 'timestamp', type: 'uint256' }],
    outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'vestingStart', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint48' }] },
] as const;

const app = new Hono();

app.get('/me', async (c) => {
  // Hackathon auth: wallet address from header (full Privy JWT verification deferred)
  const creator = c.req.header('X-Creator-Address')?.toLowerCase();
  if (!creator || !/^0x[0-9a-f]{40}$/.test(creator)) {
    return c.json({ error: 'X-Creator-Address header required (valid Ethereum address)' }, 401);
  }

  // Load creator's tokens
  const creatorTokens = await db.select().from(tokens)
    .where(eq(tokens.creator, creator))
    .orderBy(desc(tokens.launchedAt));

  if (creatorTokens.length === 0) return c.json({ creator, tokens: [] });

  const since30 = new Date(Date.now() - 30 * 86_400_000);

  const tokenDetails = await Promise.all(creatorTokens.map(async (t) => {
    // Active service
    const svc = await db.query.services.findFirst({
      where: and(eq(services.asset, t.asset), eq(services.active, true)),
    });

    // Revenue metrics
    const [revenueRow] = await db
      .select({
        revenue: sql<string>`COALESCE(SUM(CASE WHEN ${gatewayRequests.settled} AND ${gatewayRequests.settleTxHash} IS NOT NULL THEN CAST(${gatewayRequests.amountUsdc} AS NUMERIC) ELSE 0 END), 0)`.as('revenue'),
        calls:   sql<number>`COUNT(*)`.as('calls'),
      })
      .from(gatewayRequests)
      .where(and(
        eq(gatewayRequests.asset,   t.asset),
        eq(gatewayRequests.settled, true),
        gte(gatewayRequests.createdAt, since30),
      ));

    // On-chain escrow + vesting (non-fatal)
    let escrow: object | null = null;
    let vesting: object | null = null;

    try {
      const [claimable, data] = await Promise.all([
        publicClient.readContract({ address: ESCROW_ADDR, abi: escrowAbi, functionName: 'claimable', args: [t.asset as Address] }),
        publicClient.readContract({ address: ESCROW_ADDR, abi: escrowAbi, functionName: 'tokenData', args: [t.asset as Address] }),
      ]);
      escrow = {
        claimableUsdc:   claimable.toString(),
        usdcAccrued:     data.usdcAccrued.toString(),
        usdcClaimed:     data.usdcClaimed.toString(),
        recordedRevenue: data.recordedRevenue.toString(),
        forfeited:       data.forfeited,
        launchTime:      Number(data.launchTime),
        forfeitAt:       Number(data.launchTime) + 365 * 86400,
      };
    } catch { /* ignore */ }

    try {
      const now = BigInt(Math.floor(Date.now() / 1000));
      const [allocated, vestedNow, vestStart] = await Promise.all([
        publicClient.readContract({ address: t.asset as Address, abi: vestingAbi, functionName: 'totalAllocatedOf', args: [creator as Address] }),
        publicClient.readContract({ address: t.asset as Address, abi: vestingAbi, functionName: 'vestedAmount', args: [creator as Address, now] }),
        publicClient.readContract({ address: t.asset as Address, abi: vestingAbi, functionName: 'vestingStart' }),
      ]);
      vesting = {
        totalAllocated: allocated.toString(),
        vestedNow:      vestedNow.toString(),
        vestingStart:   Number(vestStart),
        cliffEnd:       Number(vestStart) + 30 * 86400,
        vestingEnd:     Number(vestStart) + 365 * 86400,
      };
    } catch { /* ignore */ }

    return {
      asset:       t.asset,
      name:        t.name,
      symbol:      t.symbol,
      router:      t.router,
      imageUrl:    t.imageUrl,
      launchedAt:  t.launchedAt,
      service: svc ? {
        id:          svc.id,
        slug:        svc.slug,
        name:        svc.name,
        priceUsdc:   svc.priceUsdc,
        active:      svc.active,
      } : null,
      metrics30d: {
        revenue: revenueRow?.revenue ?? '0',
        calls:   revenueRow?.calls   ?? 0,
      },
      escrow,
      vesting,
    };
  }));

  return c.json({ creator, tokens: tokenDetails });
});

export default app;

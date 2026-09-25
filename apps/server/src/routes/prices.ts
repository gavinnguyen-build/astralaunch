// GET /api/prices/mon — Chainlink MON/USD price from on-chain oracle.
// 60-second in-memory cache to avoid RPC spam. Rejects stale oracle data (> 1 hour).
import { Hono } from 'hono';
import { createPublicClient, defineChain, http } from 'viem';
import { RPC_URL, CHAIN_ID } from '../env.js';
import { MON_USD_ORACLE, MAX_ORACLE_STALENESS_S } from '@astralaunch/shared';

const monad = defineChain({
  id: CHAIN_ID,
  name: 'Monad',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const publicClient = createPublicClient({ chain: monad, transport: http(RPC_URL) });

const latestRoundDataAbi = [
  {
    type: 'function' as const, name: 'latestRoundData' as const, stateMutability: 'view' as const,
    inputs: [],
    outputs: [
      { type: 'uint80' },  // roundId
      { type: 'int256' },  // answer
      { type: 'uint256' }, // startedAt
      { type: 'uint256' }, // updatedAt
      { type: 'uint80' },  // answeredInRound
    ],
  },
] as const;

// Simple in-memory cache (60 s TTL).
let cache: { priceUsd: number; updatedAt: number; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 60_000;

const pricesRouter = new Hono();

pricesRouter.get('/mon', async (c) => {
  const now = Date.now();

  // Return cached value if fresh.
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return c.json({ priceUsd: cache.priceUsd, updatedAt: cache.updatedAt, source: 'chainlink' });
  }

  try {
    const [, answer, , updatedAt] = await publicClient.readContract({
      address: MON_USD_ORACLE as `0x${string}`,
      abi: latestRoundDataAbi,
      functionName: 'latestRoundData',
    });

    const block = await publicClient.getBlock();
    const blockTs = Number(block.timestamp);
    const oracleUpdatedAt = Number(updatedAt);

    if (blockTs - oracleUpdatedAt > MAX_ORACLE_STALENESS_S) {
      return c.json(
        { error: 'Oracle data stale', blockTimestamp: blockTs, oracleUpdatedAt, maxStaleness: MAX_ORACLE_STALENESS_S },
        503,
      );
    }

    // Chainlink MON/USD has 8 decimals.
    const priceUsd = Number(answer) / 1e8;

    cache = { priceUsd, updatedAt: oracleUpdatedAt, fetchedAt: now };

    return c.json({ priceUsd, updatedAt: oracleUpdatedAt, source: 'chainlink' });
  } catch (err: any) {
    console.error('[prices/mon] Oracle read failed:', err.shortMessage ?? err.message);
    return c.json({ error: 'Oracle read failed' }, 503);
  }
});

export default pricesRouter;

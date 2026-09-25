/**
 * USD per numeraire (D-MK1). USDC = 1 USD. WMON = Chainlink MON/USD (MON_USD_ORACLE, 8 decimals,
 * verified on mainnet 2026-09-25), cached 60 s; stale (> MAX_ORACLE_STALENESS_S) or non-positive
 * answers return null so the UI shows "—" instead of a wrong USD value.
 */
import { MAX_ORACLE_STALENESS_S, USDC, WMON } from '@astralaunch/shared';
import type { UsdRate, UsdResolver } from './market.js';

export interface FeedRound { answer: bigint; updatedAt: bigint; decimals: number }

export function createUsdResolver(
  readMonUsd: () => Promise<FeedRound>,
  nowS: () => bigint = () => BigInt(Math.floor(Date.now() / 1000)),
  ttlMs = 60_000,
): UsdResolver {
  let cached: { at: number; rate: UsdRate } | null = null;
  return async (numeraire) => {
    const n = numeraire.toLowerCase();
    if (n === USDC.toLowerCase()) return { price: 10n ** 8n, decimals: 8 };
    if (n !== WMON.toLowerCase()) return null;
    if (cached && Date.now() - cached.at < ttlMs) return cached.rate;
    let rate: UsdRate = null;
    try {
      const r = await readMonUsd();
      const fresh = nowS() - r.updatedAt <= BigInt(MAX_ORACLE_STALENESS_S);
      rate = r.answer > 0n && fresh ? { price: r.answer, decimals: r.decimals } : null;
    } catch { rate = null; }
    cached = { at: Date.now(), rate };
    return rate;
  };
}

const aggregatorAbi = [
  { type: 'function', name: 'latestRoundData', stateMutability: 'view', inputs: [], outputs: [
    { name: 'roundId', type: 'uint80' }, { name: 'answer', type: 'int256' }, { name: 'startedAt', type: 'uint256' },
    { name: 'updatedAt', type: 'uint256' }, { name: 'answeredInRound', type: 'uint80' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

/** Chainlink reader for a viem public client. */
export function chainlinkReader(client: { readContract: (a: any) => Promise<unknown> }, feed: `0x${string}`) {
  return async (): Promise<FeedRound> => {
    const [round, decimals] = await Promise.all([
      client.readContract({ address: feed, abi: aggregatorAbi, functionName: 'latestRoundData' }) as Promise<readonly [bigint, bigint, bigint, bigint, bigint]>,
      client.readContract({ address: feed, abi: aggregatorAbi, functionName: 'decimals' }) as Promise<number>,
    ]);
    return { answer: round[1], updatedAt: round[3], decimals: Number(decimals) };
  };
}

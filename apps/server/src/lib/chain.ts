/** Shared chain access for routes: one viem client, the USD resolver, known-address labels. */
import { createPublicClient, defineChain, http, type Address } from 'viem';
import { AIRLOCK, INITIALIZER, MON_USD_ORACLE, POOL_MANAGER } from '@astralaunch/shared';
import { CHAIN_ID, ESCROW_ADDR, RPC_URL, VAULT_ADDR } from '../env.js';
import { chainlinkReader, createUsdResolver } from '../services/usdRates.js';
import { DEAD } from '../services/market.js';
import type { CreatorChain } from '../services/creatorDashboard.js';

const monad = defineChain({
  id: CHAIN_ID, name: 'Monad',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
export const publicClient = createPublicClient({ chain: monad, transport: http(RPC_URL) });

export const usdResolver = createUsdResolver(chainlinkReader(publicClient, MON_USD_ORACLE as Address));

/** Labels for holder lists (lowercase address → label). */
export function holderLabels(creator?: string): Record<string, string> {
  const l: Record<string, string> = {
    [POOL_MANAGER.toLowerCase()]: 'Uniswap v4 pool',
    [VAULT_ADDR.toLowerCase()]: 'Buyback vault',
    [ESCROW_ADDR.toLowerCase()]: 'Fee escrow',
    [AIRLOCK.toLowerCase()]: 'Doppler Airlock',
    [DEAD]: 'Burn address',
  };
  if (creator) l[creator.toLowerCase()] = 'Creator';
  return l;
}

const initializerAbi = [
  { type: 'function', name: 'collectFees', stateMutability: 'nonpayable', inputs: [{ name: 'poolId', type: 'bytes32' }],
    outputs: [{ name: 'fees0', type: 'uint128' }, { name: 'fees1', type: 'uint128' }] },
  { type: 'function', name: 'getShares', stateMutability: 'view',
    inputs: [{ name: 'poolId', type: 'bytes32' }, { name: 'beneficiary', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;
const escrowAbi = [
  { type: 'function', name: 'claimable', stateMutability: 'view', inputs: [{ name: 'asset', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'claimableWmon', stateMutability: 'view', inputs: [{ name: 'asset', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'tokenData', stateMutability: 'view', inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{ type: 'tuple', components: [
      { name: 'creator', type: 'address' }, { name: 'launchTime', type: 'uint48' }, { name: 'forfeited', type: 'bool' },
      { name: 'usdcAccrued', type: 'uint128' }, { name: 'usdcClaimed', type: 'uint128' }, { name: 'tokenPending', type: 'uint128' },
      { name: 'recordedRevenue', type: 'uint128' }, { name: 'poolId', type: 'bytes32' }] }] },
] as const;
// DopplerERC20 (derc20V2 ABI) vesting: verified read-only on mainnet SIGHT 2026-09-25.
const vestingAbi = [
  { type: 'function', name: 'getScheduleIdsOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256[]' }] },
  { type: 'function', name: 'vestingOf', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'uint256' }],
    outputs: [{ name: 'totalAmount', type: 'uint256' }, { name: 'releasedAmount', type: 'uint256' }] },
  { type: 'function', name: 'vestingSchedules', stateMutability: 'view', inputs: [{ type: 'uint256' }],
    outputs: [{ name: 'cliff', type: 'uint64' }, { name: 'duration', type: 'uint64' }] },
  { type: 'function', name: 'computeAvailableVestedAmount', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'vestingStart', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;

export const creatorChain: CreatorChain = {
  async tradingFees(poolId, wallet) {
    const [sim, share] = await Promise.all([
      publicClient.simulateContract({ address: INITIALIZER as Address, abi: initializerAbi, functionName: 'collectFees',
        args: [poolId as `0x${string}`], account: wallet as Address }),
      publicClient.readContract({ address: INITIALIZER as Address, abi: initializerAbi, functionName: 'getShares',
        args: [poolId as `0x${string}`, wallet as Address] }),
    ]);
    return { fees0: sim.result[0], fees1: sim.result[1], share };
  },
  escrowClaimable: (asset, wmon) => publicClient.readContract({ address: ESCROW_ADDR, abi: escrowAbi,
    functionName: wmon ? 'claimableWmon' : 'claimable', args: [asset as Address] }),
  async escrowData(asset) {
    const d = await publicClient.readContract({ address: ESCROW_ADDR, abi: escrowAbi, functionName: 'tokenData', args: [asset as Address] });
    return { creator: d.creator, launchTime: Number(d.launchTime), forfeited: d.forfeited,
      usdcAccrued: d.usdcAccrued, usdcClaimed: d.usdcClaimed, recordedRevenue: d.recordedRevenue };
  },
  async vesting(asset, wallet) {
    const a = asset as Address, w = wallet as Address;
    const [ids, releasable, start] = await Promise.all([
      publicClient.readContract({ address: a, abi: vestingAbi, functionName: 'getScheduleIdsOf', args: [w] }),
      publicClient.readContract({ address: a, abi: vestingAbi, functionName: 'computeAvailableVestedAmount', args: [w] }),
      publicClient.readContract({ address: a, abi: vestingAbi, functionName: 'vestingStart' }),
    ]);
    let total = 0n, released = 0n, cliffS = 0, durationS = 0;
    for (const id of ids) {
      const [v, s] = await Promise.all([
        publicClient.readContract({ address: a, abi: vestingAbi, functionName: 'vestingOf', args: [w, id] }),
        publicClient.readContract({ address: a, abi: vestingAbi, functionName: 'vestingSchedules', args: [id] }),
      ]);
      total += v[0]; released += v[1];
      if (!cliffS) { cliffS = Number(s[0]); durationS = Number(s[1]); }
    }
    return { total, released, releasable, start: Number(start), cliffS, durationS };
  },
};

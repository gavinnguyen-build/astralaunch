/**
 * viem public client for Monad + Doppler SDK config for launching tokens.
 */
import { createPublicClient, http, defineChain } from 'viem';
import { CHAIN_ID, RPC_URL } from '../env.js';

export const monadChain = defineChain({
  id:   CHAIN_ID,
  name: 'Monad',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: {
    default: { name: 'Monad Explorer', url: 'https://explorer.monad.xyz' },
  },
});

export const publicClient = createPublicClient({
  chain:     monadChain,
  transport: http(RPC_URL),
});

// ── AstralaunchRegistry ABI (minimal) ─────────────────────────────────────────
export const registryAbi = [
  { type: 'function', name: 'register',      stateMutability: 'nonpayable',
    inputs: [{ name: 'asset', type: 'address' }, { name: 'creator', type: 'address' }],
    outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'isRegistered',  stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'routers',       stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],      outputs: [{ type: 'address' }] },
] as const;

// ── FeeEscrow ABI (minimal) ───────────────────────────────────────────────────
export const escrowAbi = [
  { type: 'function', name: 'claimable', stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'claim',     stateMutability: 'nonpayable',
    inputs: [{ name: 'asset', type: 'address' }], outputs: [] },
] as const;

// ── BuybackVault ABI (minimal) ────────────────────────────────────────────────
export const vaultAbi = [
  { type: 'function', name: 'execute',  stateMutability: 'nonpayable',
    inputs: [{ name: 'asset', type: 'address' }, { name: 'usdcIn', type: 'uint256' }, { name: 'minTokenOut', type: 'uint256' }],
    outputs: [] },
] as const;

// ── DopplerERC20V1 vesting ABI ─────────────────────────────────────────────
export const vestingAbi = [
  { type: 'function', name: 'claim',    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'vestedAmount', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }, { name: 'timestamp', type: 'uint256' }],
    outputs: [{ type: 'uint256' }] },
] as const;

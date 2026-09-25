/** Browser env vars — all must be prefixed VITE_ */
import { MONAD_EXPLORER_URL } from '@astralaunch/shared';

export const API_BASE      = import.meta.env.VITE_API_BASE      ?? '';
export const PRIVY_APP_ID  = import.meta.env.VITE_PRIVY_APP_ID  ?? '';
export const CHAIN_ID      = Number(import.meta.env.VITE_CHAIN_ID ?? 143);
export const RPC_URL       = import.meta.env.VITE_RPC_URL        ?? 'https://rpc.monad.xyz';
export const REGISTRY_ADDR = (import.meta.env.VITE_REGISTRY_ADDR ?? '') as `0x${string}`;
export const ESCROW_ADDR   = (import.meta.env.VITE_ESCROW_ADDR   ?? '') as `0x${string}`;
export const VAULT_ADDR    = (import.meta.env.VITE_VAULT_ADDR    ?? '') as `0x${string}`;
export const EXPLORER_URL  = (import.meta.env.VITE_EXPLORER_URL ?? MONAD_EXPLORER_URL).replace(/\/$/, '');

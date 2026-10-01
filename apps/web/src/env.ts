/** Browser env vars — all must be prefixed VITE_ */
import { explorerBase } from './lib/explorer.js';

/** Server origin for /api/* and the /s/* gateway, e.g. https://api.astralaunch.xyz (build-time). Empty = same
 *  origin (dev: the Vite proxy forwards /api and /s/ to API_PROXY_TARGET, default http://localhost:3001). */
export const API_BASE      = (import.meta.env.VITE_API_BASE      ?? '').replace(/\/$/, '');
export const PRIVY_APP_ID  = import.meta.env.VITE_PRIVY_APP_ID  ?? '';
export const CHAIN_ID      = Number(import.meta.env.VITE_CHAIN_ID ?? 143);
export const RPC_URL       = import.meta.env.VITE_RPC_URL        ?? 'https://rpc.monad.xyz';
export const REGISTRY_ADDR = (import.meta.env.VITE_REGISTRY_ADDR ?? '') as `0x${string}`;
export const ESCROW_ADDR   = (import.meta.env.VITE_ESCROW_ADDR   ?? '') as `0x${string}`;
export const VAULT_ADDR    = (import.meta.env.VITE_VAULT_ADDR    ?? '') as `0x${string}`;
/** Absolute explorer base: VITE_EXPLORER_URL if it is an http(s) URL, else https://monadscan.com (lib/explorer.ts). */
export const EXPLORER_URL  = explorerBase(import.meta.env.VITE_EXPLORER_URL);

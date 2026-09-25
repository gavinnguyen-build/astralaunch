import { ESCROW_ADDR, VAULT_ADDR, REGISTRY_ADDR } from '../env.js';
import type { PlatformAddrs } from '../services/cleanRevenue.js';

/** Platform contract addresses from env (never clean payers). */
export function platformAddrs(): PlatformAddrs {
  return {
    escrow: ESCROW_ADDR, vault: VAULT_ADDR, registry: REGISTRY_ADDR,
    pfr: process.env.PLATFORM_FEE_RECEIVER_ADDRESS, treasury: process.env.TREASURY_ADDRESS,
  };
}

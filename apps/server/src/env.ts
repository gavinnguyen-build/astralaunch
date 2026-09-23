import { config } from 'dotenv';
import { USDC, X402_FACILITATOR_URL_DEFAULT } from '@revpad/shared';

config({ path: '../../.env' });
// also allow local override
config({ path: '.env', override: false });

function need(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env var ${k}`);
  return v;
}

export const PORT               = Number(process.env.PORT ?? 3001);
export const DATABASE_URL       = need('DATABASE_URL');
export const RPC_URL            = need('MONAD_RPC_URL');
export const CHAIN_ID           = Number(process.env.MONAD_CHAIN_ID ?? 143);
export const USDC_ADDR          = (process.env.USDC_ADDRESS ?? USDC) as `0x${string}`;
export const REGISTRY_ADDR      = need('REVPAD_REGISTRY_ADDRESS') as `0x${string}`;
export const ESCROW_ADDR        = need('FEE_ESCROW_ADDRESS') as `0x${string}`;
export const VAULT_ADDR         = need('BUYBACK_VAULT_ADDRESS') as `0x${string}`;
export const FACILITATOR_URL    = process.env.X402_FACILITATOR_URL ?? X402_FACILITATOR_URL_DEFAULT;
export const HMAC_MASTER_KEY    = need('GATEWAY_HMAC_MASTER_KEY');
/** Comma-separated list of known facilitator submitters (clean-revenue signal). */
export const SUBMITTERS         = (process.env.FACILITATOR_SUBMITTER_ADDRESSES ?? '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

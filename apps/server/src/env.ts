import { config } from 'dotenv';
import { createPublicClient, defineChain, getAddress, http } from 'viem';
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
/** Payment authorization window in seconds. Default 60; set higher on a test fork when
 *  block time may have been advanced past wall-clock time (e.g. after keeper cooldown warp). */
export const PAYMENT_TIMEOUT_S  = Number(process.env.PAYMENT_TIMEOUT_SECONDS ?? 60);

// ── Startup contract verification ──────────────────────────────────────────
const adminAbi = [{ type: 'function', name: 'admin', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }] as const;

/** Verify all contract addresses have code and admin wiring matches ADMIN_ADDRESS (if set). */
export async function verifyContracts(): Promise<void> {
  const chain = defineChain({
    id: CHAIN_ID,
    name: 'Monad',
    nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  });
  const client = createPublicClient({ chain, transport: http(RPC_URL) });

  const addrs: Array<{ name: string; addr: `0x${string}` }> = [
    { name: 'RevpadRegistry', addr: REGISTRY_ADDR },
    { name: 'FeeEscrow', addr: ESCROW_ADDR },
    { name: 'BuybackVault', addr: VAULT_ADDR },
  ];

  for (const { name, addr } of addrs) {
    const code = await client.getCode({ address: addr });
    if (!code || code === '0x') {
      throw new Error(`FATAL: ${name} (${addr}) has no bytecode on chain ${CHAIN_ID}. Wrong address or network.`);
    }
  }

  const expectedAdmin = process.env.ADMIN_ADDRESS;
  if (expectedAdmin) {
    const expected = getAddress(expectedAdmin);
    for (const contract of ['RevpadRegistry', 'PlatformFeeReceiver'] as const) {
      const addr = contract === 'RevpadRegistry' ? REGISTRY_ADDR : need('PLATFORM_FEE_RECEIVER_ADDRESS') as `0x${string}`;
      const actual = await client.readContract({ address: addr, abi: adminAbi, functionName: 'admin' });
      if (getAddress(actual) !== expected) {
        throw new Error(
          `FATAL: ${contract}.admin() = ${actual}, expected ADMIN_ADDRESS = ${expected}. Wrong deployment or network.`
        );
      }
    }
    console.log(`[server] Admin wiring verified: ${expected}`);
  }

  console.log(`[server] Contract addresses verified on chain ${CHAIN_ID}`);
}

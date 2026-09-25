import { config } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import { createPublicClient, defineChain, getAddress, http } from 'viem';
import { AIRLOCK, LAUNCH_FEE_TREASURY, LAUNCH_FEE_WEI, USDC, X402_FACILITATOR_URL_DEFAULT } from '@astralaunch/shared';
import { parseCorsOrigins } from './lib/cors.js';

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
export const REGISTRY_ADDR      = (process.env.ASTRALAUNCH_REGISTRY_ADDRESS ?? (() => { throw new Error('Missing env var ASTRALAUNCH_REGISTRY_ADDRESS'); })()) as `0x${string}`;
export const GUARDIAN_ADDR      = process.env.GUARDIAN_ADDRESS as `0x${string}` | undefined;
export const ESCROW_ADDR        = need('FEE_ESCROW_ADDRESS') as `0x${string}`;
export const VAULT_ADDR         = need('BUYBACK_VAULT_ADDRESS') as `0x${string}`;
export const FACILITATOR_URL    = process.env.X402_FACILITATOR_URL ?? X402_FACILITATOR_URL_DEFAULT;
export const HMAC_MASTER_KEY    = need('GATEWAY_HMAC_MASTER_KEY');
/** Bearer token for /api/admin/*. Unset = admin API disabled. */
export const ADMIN_API_KEY      = process.env.ADMIN_API_KEY || undefined;
/** Comma-separated list of known facilitator submitters (clean-revenue signal). */
export const SUBMITTERS         = (process.env.FACILITATOR_SUBMITTER_ADDRESSES ?? '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
/** Payment authorization window in seconds. Default 60; set higher on a test fork when
 *  block time may have been advanced past wall-clock time (e.g. after keeper cooldown warp). */
/** Browser origins allowed to call /api/* and /s/* cross-origin (comma-separated). Empty = none. */
export const CORS_ORIGINS       = parseCorsOrigins(process.env.CORS_ORIGINS);
export const PAYMENT_TIMEOUT_S  = Number(process.env.PAYMENT_TIMEOUT_SECONDS ?? 60);
/** LaunchHelper (one-tx launch + fee). Unset/empty = feature off: web uses the multi-tx flow. Checked at startup. */
export const LAUNCH_HELPER_ADDR = (() => {
  const v = process.env.LAUNCH_HELPER_ADDRESS?.trim();
  if (!v) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`LAUNCH_HELPER_ADDRESS is not an address: ${v}`);
  return getAddress(v);
})();

// ── Startup contract verification ──────────────────────────────────────────
const adminAbi = [{ type: 'function', name: 'admin', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }] as const;
const launchHelperAbi = [
  { type: 'function', name: 'airlock',   stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'registry',  stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'treasury',  stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'launchFee', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;

/** Verify all contract addresses have code, admin wiring, and dryRun flag. */
export async function verifyContracts(): Promise<void> {
  // Check dryRun flag in contracts JSON if CONTRACTS_JSON_PATH is set.
  const contractsPath = process.env.CONTRACTS_JSON_PATH;
  if (contractsPath && existsSync(contractsPath)) {
    const contracts = JSON.parse(readFileSync(contractsPath, 'utf8'));
    if (contracts.dryRun === true) {
      throw new Error(
        `FATAL: ${contractsPath} has "dryRun": true. ` +
        `These addresses are from a simulation, not a real deployment. ` +
        `Re-run Deploy.s.sol with --broadcast to produce a real deployment.`
      );
    }
  }

  const chain = defineChain({
    id: CHAIN_ID,
    name: 'Monad',
    nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  });
  const client = createPublicClient({ chain, transport: http(RPC_URL) });

  const addrs: Array<{ name: string; addr: `0x${string}` }> = [
    { name: 'AstralaunchRegistry', addr: REGISTRY_ADDR },
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
    for (const contract of ['AstralaunchRegistry', 'PlatformFeeReceiver'] as const) {
      const addr = contract === 'AstralaunchRegistry' ? REGISTRY_ADDR : need('PLATFORM_FEE_RECEIVER_ADDRESS') as `0x${string}`;
      const actual = await client.readContract({ address: addr, abi: adminAbi, functionName: 'admin' });
      if (getAddress(actual) !== expected) {
        throw new Error(
          `FATAL: ${contract}.admin() = ${actual}, expected ADMIN_ADDRESS = ${expected}. Wrong deployment or network.`
        );
      }
    }
    console.log(`[server] Admin wiring verified: ${expected}`);
  }

  if (LAUNCH_HELPER_ADDR) {
    const code = await client.getCode({ address: LAUNCH_HELPER_ADDR });
    if (!code || code === '0x') throw new Error(`FATAL: LaunchHelper (${LAUNCH_HELPER_ADDR}) has no bytecode on chain ${CHAIN_ID}.`);
    const read = <F extends 'airlock' | 'registry' | 'treasury' | 'launchFee'>(functionName: F) =>
      client.readContract({ address: LAUNCH_HELPER_ADDR, abi: launchHelperAbi, functionName });
    const [airlock, registry, treasury, fee] = await Promise.all([read('airlock'), read('registry'), read('treasury'), read('launchFee')]);
    const wrong = [
      getAddress(airlock as string) !== getAddress(AIRLOCK) && `airlock ${airlock} != ${AIRLOCK}`,
      getAddress(registry as string) !== getAddress(REGISTRY_ADDR) && `registry ${registry} != ${REGISTRY_ADDR}`,
      getAddress(treasury as string) !== getAddress(LAUNCH_FEE_TREASURY) && `treasury ${treasury} != ${LAUNCH_FEE_TREASURY}`,
      (fee as bigint) !== LAUNCH_FEE_WEI && `launchFee ${fee} != ${LAUNCH_FEE_WEI}`,
    ].filter(Boolean);
    if (wrong.length) throw new Error(`FATAL: LaunchHelper ${LAUNCH_HELPER_ADDR} does not match this deployment: ${wrong.join('; ')}`);
    console.log(`[server] LaunchHelper verified: ${LAUNCH_HELPER_ADDR}`);
  }

  console.log(`[server] Contract addresses verified on chain ${CHAIN_ID}`);
}

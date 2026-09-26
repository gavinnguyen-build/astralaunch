import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { USDC, FACILITATOR_SUBMITTERS, POOL_MANAGER } from '@astralaunch/shared';

config({ path: '../../.env' });
config({ path: '.env', override: false });

function need(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env var ${k}`);
  return v;
}

// ── Contracts JSON — single source for addresses + start block ───────────────
// A redeploy only needs a new JSON; no hardcoded addresses.

const contractsPath = need('CONTRACTS_JSON_PATH');
const contracts = JSON.parse(readFileSync(contractsPath, 'utf8')) as {
  registry:            string;
  escrow:              string;
  vault:               string;
  platformFeeReceiver: string;
  blockNumber:         number;
  chainId:             number;
  dryRun:              boolean;
};

if (contracts.dryRun) {
  throw new Error(
    `FATAL: ${contractsPath} has "dryRun": true — these are simulation addresses. ` +
    `Re-run Deploy.s.sol with --broadcast.`,
  );
}

export const REGISTRY_ADDR = contracts.registry as `0x${string}`;
export const ESCROW_ADDR   = contracts.escrow as `0x${string}`;
export const VAULT_ADDR    = contracts.vault as `0x${string}`;
export const PFR_ADDR      = contracts.platformFeeReceiver as `0x${string}`;
export const START_BLOCK   = BigInt(contracts.blockNumber);
export const CHAIN_ID      = contracts.chainId;

/** Positive number from env; blank = fallback. */
function positive(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${key} must be a positive number of seconds, got "${raw}"`);
  return n;
}

export const DATABASE_URL      = need('DATABASE_URL');
export const MONAD_RPC_URL     = need('MONAD_RPC_URL');
export const CHUNK_SIZE        = Number(process.env.INDEXER_CHUNK_SIZE ?? 10_000);
export const POLL_INTERVAL_S   = positive('INDEXER_POLL_INTERVAL_S', 10);
/**
 * Market data (swaps + asset transfers of registered pools) is polled on its own, faster cadence so a
 * trade shows up within seconds. Same finality rule as every other set; it only moves display data.
 * Unset = POLL_INTERVAL_S (docker-compose.prod.yml sets 3).
 */
export const SWAP_POLL_INTERVAL_S = positive('INDEXER_SWAP_POLL_INTERVAL_S', POLL_INTERVAL_S);
export const FINALITY_LAG      = Number(process.env.INDEXER_FINALITY_LAG ?? 0);
export const MAX_RPS           = Number(process.env.INDEXER_MAX_RPS ?? 25);
export const RPC_TIMEOUT_MS    = Number(process.env.INDEXER_RPC_TIMEOUT_MS ?? 30_000);

export const USDC_ADDR = USDC as `0x${string}`;

/** Facilitator submitter addresses (lowercase). Used for is_facilitator_settled flag. */
export const FACILITATOR_ADDRS: ReadonlySet<string> = new Set(
  (process.env.FACILITATOR_SUBMITTER_ADDRESSES ?? '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
    .concat(FACILITATOR_SUBMITTERS.map(s => s.toLowerCase())),
);

/** Uniswap v4 PoolManager (addresses.ts). */
export const POOL_MANAGER_ADDR = POOL_MANAGER as `0x${string}`;
/** Look-back for a newly discovered pool's swaps/transfers (launch → register gap). */
export const SWAP_LOOKBACK_BLOCKS = Number(process.env.INDEXER_SWAP_LOOKBACK_BLOCKS ?? 20_000);

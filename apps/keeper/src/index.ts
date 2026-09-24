/**
 * Astralaunch keeper — scheduled on-chain job runner.
 *
 * Reads the list of registered assets from env (comma-separated ASSETS) or from
 * the server database (DATABASE_URL) and runs jobs every POLL_INTERVAL_S seconds.
 *
 * Jobs per asset (ordered by usefulness — high-value first):
 *   1. distribute — forward revenue from routers
 *   2. buyback   — swap + burn (rate-limited by contract; skipped for WMON pairs)
 *   3. collect   — pull Doppler trading fees (escrow + vault + PFR), gated by pending fee check + cadence
 *   4. forfeit   — redirect abandoned escrow to vault
 *   5. O4 swap   — swap WMON numeraire fees to USDC (stub, pending USDC/WMON pool)
 *
 * After the per-asset loop: monitor PlatformFeeReceiver for treasury proposals,
 * admin transfers, and AstralaunchRegistry for initializer proposals.
 *
 * Usage:
 *   ASSETS=0xToken1,0xToken2 ROUTERS=0xRouter1,0xRouter2 tsx src/index.ts
 *   --telegram-test  — send a dry-run Telegram alert and exit
 *   --dry-run        — estimate gas but send no transactions
 *
 * Or with DATABASE_URL set, assets/routers are loaded from Postgres.
 */
import { config } from 'dotenv';
import { formatEther, isAddress, type Address } from 'viem';
import { runAssetJobs } from './jobs.js';
import {
  PLATFORM_FEE_RECEIVER,
  REGISTRY,
  RPC_URL,
  DRY_RUN,
  publicClient,
  refreshGasPrice,
  refreshWalletBalance,
  verifyContracts,
} from './chain.js';
import { monitorTreasuryProposal, monitorAdminTransfers, monitorInitializerProposal, dryRunTelegramAlert } from './telegram.js';
import { SpendGuardError } from './spend.js';
import { KEEPER_DEFAULT_INTERVAL_S, KEEPER_MIN_INTERVAL_S } from '@astralaunch/shared';

config({ path: '../../.env' });
config({ path: '.env', override: false });

// ── Interval guard ──────────────────────────────────────────────────────────

function resolveInterval(): number {
  const configured = Number(process.env.POLL_INTERVAL_S ?? KEEPER_DEFAULT_INTERVAL_S);
  const isLocal = /localhost|127\.0\.0\.1/.test(RPC_URL);

  if (!isLocal && configured < KEEPER_MIN_INTERVAL_S) {
    console.warn(
      `[keeper] POLL_INTERVAL_S=${configured} is below minimum ${KEEPER_MIN_INTERVAL_S}s for non-localhost RPC. Clamping to ${KEEPER_MIN_INTERVAL_S}s.`,
    );
    return KEEPER_MIN_INTERVAL_S;
  }

  return configured;
}

const POLL_INTERVAL_S = resolveInterval();

/** Load asset+router pairs from env vars (for simple/fork usage without Postgres). */
function loadFromEnv(): Array<{ asset: Address; router: Address }> {
  const assets  = (process.env.ASSETS  ?? '').split(',').map(s => s.trim()).filter(s => isAddress(s));
  const routers = (process.env.ROUTERS ?? '').split(',').map(s => s.trim()).filter(s => isAddress(s));
  if (assets.length !== routers.length) throw new Error('ASSETS and ROUTERS must have equal length');
  return assets.map((asset, i) => ({ asset: asset as Address, router: routers[i] as Address }));
}

async function runOnce(pairs: Array<{ asset: Address; router: Address }>) {
  // Refresh gas price and wallet balance at the start of each tick
  await refreshGasPrice();
  const balance = await refreshWalletBalance();

  console.log(
    `[keeper] tick — ${pairs.length} asset(s)  balance=${formatEther(balance)} MON  ${new Date().toISOString()}`,
  );

  try {
    for (const { asset, router } of pairs) {
      // Order: distribute, buyback (high value) before collect (expensive, may have nothing)
      await runAssetJobs(asset, router);
    }
  } catch (e) {
    if (e instanceof SpendGuardError) {
      console.warn(`[keeper] Spend guard triggered — aborting remaining jobs: ${e.message}`);
      return;
    }
    throw e;
  }

  // Monitor treasury proposals, admin transfers, and initializer proposals after all per-asset jobs
  await monitorTreasuryProposal(PLATFORM_FEE_RECEIVER, publicClient);
  await monitorAdminTransfers(PLATFORM_FEE_RECEIVER, REGISTRY, publicClient);
  await monitorInitializerProposal();
}

async function main() {
  // Handle --telegram-test flag
  if (process.argv.includes('--telegram-test')) {
    await dryRunTelegramAlert();
    process.exit(0);
  }

  if (DRY_RUN) {
    console.log('[keeper] DRY RUN MODE — no transactions will be sent');
  }

  // Verify contract addresses have code and admin wiring before starting jobs.
  await verifyContracts();

  const pairs = loadFromEnv();
  if (pairs.length === 0) {
    console.warn('[keeper] No assets configured. Set ASSETS and ROUTERS env vars.');
  }
  console.log(
    `[keeper] starting — poll every ${POLL_INTERVAL_S}s  assets=${pairs.map(p => p.asset).join(',')}` +
    (DRY_RUN ? '  [DRY-RUN]' : ''),
  );

  // Run immediately on start, then on schedule
  await runOnce(pairs);
  setInterval(() => runOnce(pairs).catch(console.error), POLL_INTERVAL_S * 1000);
}

main().catch(e => { console.error(e); process.exit(1); });

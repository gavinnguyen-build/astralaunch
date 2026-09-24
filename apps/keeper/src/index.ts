/**
 * Revpad keeper — scheduled on-chain job runner.
 *
 * Reads the list of registered assets from env (comma-separated ASSETS) or from
 * the server database (DATABASE_URL) and runs jobs every POLL_INTERVAL_S seconds.
 *
 * Jobs per asset (in order):
 *   1. collect   — pull Doppler trading fees (escrow + vault)
 *   2. collectPFR — pull platform trading fees via PlatformFeeReceiver
 *   3. distribute — forward revenue from routers
 *   4. buyback   — swap + burn (rate-limited by contract)
 *   5. forfeit   — redirect abandoned escrow to vault
 *
 * After the per-asset loop: monitor PlatformFeeReceiver for treasury proposals.
 *
 * Usage:
 *   ASSETS=0xToken1,0xToken2 ROUTERS=0xRouter1,0xRouter2 tsx src/index.ts
 *   --telegram-test  — send a dry-run Telegram alert and exit
 *
 * Or with DATABASE_URL set, assets/routers are loaded from Postgres.
 */
import { config } from 'dotenv';
import { isAddress, type Address } from 'viem';
import { jobCollect, jobDistribute, jobBuyback, jobForfeit, jobCollectPlatformFee } from './jobs.js';
import { PLATFORM_FEE_RECEIVER, REGISTRY, publicClient, verifyContracts } from './chain.js';
import { monitorTreasuryProposal, monitorAdminTransfers, dryRunTelegramAlert } from './telegram.js';

config({ path: '../../.env' });
config({ path: '.env', override: false });

const POLL_INTERVAL_S = Number(process.env.POLL_INTERVAL_S ?? 30);

/** Load asset+router pairs from env vars (for simple/fork usage without Postgres). */
function loadFromEnv(): Array<{ asset: Address; router: Address }> {
  const assets  = (process.env.ASSETS  ?? '').split(',').map(s => s.trim()).filter(s => isAddress(s));
  const routers = (process.env.ROUTERS ?? '').split(',').map(s => s.trim()).filter(s => isAddress(s));
  if (assets.length !== routers.length) throw new Error('ASSETS and ROUTERS must have equal length');
  return assets.map((asset, i) => ({ asset: asset as Address, router: routers[i] as Address }));
}

async function runOnce(pairs: Array<{ asset: Address; router: Address }>) {
  console.log(`[keeper] tick — ${pairs.length} asset(s)  ${new Date().toISOString()}`);
  for (const { asset, router } of pairs) {
    await jobCollect(asset);
    await jobCollectPlatformFee(asset);
    await jobDistribute(router);
    await jobBuyback(asset);
    await jobForfeit(asset);
  }
  // Monitor treasury proposals and admin transfers after all per-asset jobs
  await monitorTreasuryProposal(PLATFORM_FEE_RECEIVER, publicClient);
  await monitorAdminTransfers(PLATFORM_FEE_RECEIVER, REGISTRY, publicClient);
}

async function main() {
  // Handle --telegram-test flag
  if (process.argv.includes('--telegram-test')) {
    await dryRunTelegramAlert();
    process.exit(0);
  }

  // Verify contract addresses have code and admin wiring before starting jobs.
  await verifyContracts();

  const pairs = loadFromEnv();
  if (pairs.length === 0) {
    console.warn('[keeper] No assets configured. Set ASSETS and ROUTERS env vars.');
  }
  console.log(`[keeper] starting — poll every ${POLL_INTERVAL_S}s  assets=${pairs.map(p => p.asset).join(',')}`);

  // Run immediately on start, then on schedule
  await runOnce(pairs);
  setInterval(() => runOnce(pairs).catch(console.error), POLL_INTERVAL_S * 1000);
}

main().catch(e => { console.error(e); process.exit(1); });

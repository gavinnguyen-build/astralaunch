/**
 * Astralaunch keeper — scheduled on-chain job runner.
 *
 * Each tick loads the tokens to service from the server database (listed tokens
 * only: launch fee consumed, not hidden; see targets.ts), cross-checks each one
 * against the chain, and runs its jobs. Ticks run back to back with
 * POLL_INTERVAL_S between them, never overlapping.
 *
 * Jobs per asset (ordered by usefulness — high-value first):
 *   1. distribute — forward revenue from routers
 *   2. buyback   — swap + burn (rate-limited by contract; WMON pairs two-hop USDC → MON → WMON → token)
 *   3. collect   — pull Doppler trading fees (escrow + vault + PFR), gated by pending fee check + cadence
 *   4. forfeit   — redirect abandoned escrow to vault
 *   5. O4 swap   — swap WMON numeraire fees to USDC (stub, pending USDC/WMON pool)
 *
 * After the per-asset loop: monitor PlatformFeeReceiver for treasury proposals,
 * admin transfers, and AstralaunchRegistry for initializer proposals.
 *
 * GET /health on KEEPER_HEALTH_PORT (default 8080): 503 when no tick has succeeded
 * within 3 × POLL_INTERVAL_S. A tick that throws sends a Telegram alert.
 *
 * Usage:
 *   DATABASE_URL=postgres://… tsx src/index.ts
 *   ASSETS=0xToken1,0xToken2 [ROUTERS=0xRouter1,0xRouter2]  — debug override (see targets.ts)
 *   --telegram-test  — send a dry-run Telegram alert and exit
 *   --dry-run        — estimate gas but send no transactions
 *   --once           — run a single tick, then exit (no schedule, no health server)
 */
import { config } from 'dotenv';
import { formatEther } from 'viem';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { runTargetJobs } from './jobs.js';
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
import { loadTargets, targetSource, type Db, type KeeperTarget } from './targets.js';
import { KeeperHealth, startHealthServer } from './health.js';
import { resolveInterval } from './interval.js';
import { KEEPER_MIN_INTERVAL_S } from '@astralaunch/shared';

config({ path: '../../.env' });
config({ path: '.env', override: false });

// ── Interval guard ──────────────────────────────────────────────────────────

const interval = resolveInterval(RPC_URL, process.env.POLL_INTERVAL_S);
if (interval.clamped) {
  console.warn(
    `[keeper] POLL_INTERVAL_S=${process.env.POLL_INTERVAL_S} is below minimum ${KEEPER_MIN_INTERVAL_S}s for non-localhost RPC. Clamping to ${KEEPER_MIN_INTERVAL_S}s.`,
  );
}
const POLL_INTERVAL_S = interval.seconds;

const HEALTH_PORT = Number(process.env.KEEPER_HEALTH_PORT || 8080);

// Read-only use: the keeper only SELECTs from tokens / fee_receipts / hidden_tokens.
const db: Db | null = process.env.DATABASE_URL
  ? drizzle(postgres(process.env.DATABASE_URL, { max: 2 }))
  : null;

const health = new KeeperHealth(POLL_INTERVAL_S);

async function runOnce(targets: KeeperTarget[]) {
  // Refresh gas price and wallet balance at the start of each tick
  await refreshGasPrice();
  const balance = await refreshWalletBalance();
  health.recordBalance(balance);

  console.log(
    `[keeper] tick — ${targets.length} asset(s)  balance=${formatEther(balance)} MON  ${new Date().toISOString()}`,
  );

  try {
    for (const target of targets) {
      // Order: distribute, buyback (high value) before collect (expensive, may have nothing)
      await runTargetJobs(target);
    }
  } catch (e) {
    if (e instanceof SpendGuardError) {
      console.warn(`[keeper] Spend guard triggered — aborting remaining jobs: ${e.message}`);
      return;
    }
    throw e;
  }

  // Monitor treasury proposals, admin transfers, and initializer proposals after all per-asset jobs.
  // Alerting must never affect jobs or stop the keeper: swallow anything that escapes.
  try {
    await monitorTreasuryProposal(PLATFORM_FEE_RECEIVER, publicClient);
    await monitorAdminTransfers(PLATFORM_FEE_RECEIVER, REGISTRY, publicClient);
    await monitorInitializerProposal();
  } catch (e) {
    console.error(`[keeper] monitor/alert error (ignored): ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** One tick: discover targets fresh (no restart needed for new listings), run jobs, record health. */
async function tick(): Promise<boolean> {
  try {
    const targets = await loadTargets(process.env, db);
    await runOnce(targets);
    await health.recordSuccess(targets.length);
    return true;
  } catch (e) {
    console.error(`[keeper] tick failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    await health.recordFailure(e);
    return false;
  }
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

  // Fail fast on a malformed ASSETS/ROUTERS override or missing DATABASE_URL.
  const source = targetSource(process.env, db !== null);

  // Verify contract addresses have code and admin wiring before starting jobs.
  await verifyContracts();

  console.log(
    `[keeper] starting — poll every ${POLL_INTERVAL_S}s  targets from ${source.describe}` +
    (DRY_RUN ? '  [DRY-RUN]' : ''),
  );

  if (process.argv.includes('--once')) {
    const ok = await tick();
    console.log('[keeper] --once: single tick done, exiting');
    process.exit(ok ? 0 : 1);
  }

  if (HEALTH_PORT > 0) startHealthServer(health, HEALTH_PORT);

  // Run immediately on start, then POLL_INTERVAL_S after each tick ends (ticks never overlap).
  for (;;) {
    await tick();
    await new Promise(r => setTimeout(r, POLL_INTERVAL_S * 1000));
  }
}

main().catch(e => { console.error(e); process.exit(1); });

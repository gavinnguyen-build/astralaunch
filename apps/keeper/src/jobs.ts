/**
 * Keeper on-chain jobs (SPEC §15).
 *
 * Job order per asset (by usefulness — distribute/buyback first so a spend
 * guard hit from expensive collects never blocks them):
 *   1. distribute — forward revenue from routers
 *   2. buyback   — swap accumulated USDC → token and burn
 *   3. collect   — pull Doppler trading fees (escrow + vault + PFR)
 *   4. forfeit   — move unclaimed escrow to vault after 365 days
 *   5. swapWmonToUsdc — (O4 stub) swap WMON numeraire fees to USDC for FeeEscrow
 *
 * Collects are gated by:
 *   - Pending fee pre-check (simulateContract on initializer.collectFees)
 *   - Cadence limit: at most once per COLLECT_INTERVAL_S per beneficiary per asset
 *   - Threshold: pending numeraire must be >= MIN_COLLECT_USDC (in USDC terms)
 *
 * Dual-numeraire (v2):
 *   - For USDC-paired tokens: collect returns USDC + asset tokens (unchanged behavior)
 *   - For WMON-paired tokens: collect returns WMON + asset tokens
 *   - Buyback: skipped for WMON-paired tokens (vault reverts BuybackNotAvailable)
 *   - O4 swap: stub job to swap FeeEscrow.numerairePending WMON → USDC
 */
import { formatUnits, parseUnits, type Address } from 'viem';
import {
  publicClient, ESCROW, VAULT, PLATFORM_FEE_RECEIVER, WMON,
  sendTx, DRY_RUN, simulatePendingFees, getBeneficiaryShare,
  getAssetNumeraire,
} from './chain.js';
import {
  KEEPER_MIN_COLLECT_USDC,
  KEEPER_MIN_DISTRIBUTE_USDC,
  KEEPER_MIN_BUYBACK_USDC,
  MAX_BUYBACK_PER_CALL_USDC,
  FORFEIT_DELAY_S,
  COLLECT_INTERVAL_S as DEFAULT_COLLECT_INTERVAL_S,
  USDC as USDC_ADDR,
  WAD,
} from '@astralaunch/shared';
import { SpendGuardError } from './spend.js';

// ── Env-configurable thresholds ─────────────────────────────────────────────

function envUsdc(key: string, fallback: bigint): bigint {
  const v = process.env[key];
  if (!v) return fallback;
  return parseUnits(v, 6);
}

const minCollectUsdc    = envUsdc('MIN_COLLECT_USDC',    KEEPER_MIN_COLLECT_USDC);
const minDistributeUsdc = envUsdc('MIN_DISTRIBUTE_USDC', KEEPER_MIN_DISTRIBUTE_USDC);
const minBuybackUsdc    = envUsdc('MIN_BUYBACK_USDC',    KEEPER_MIN_BUYBACK_USDC);
const collectIntervalS  = Number(process.env.COLLECT_INTERVAL_S ?? DEFAULT_COLLECT_INTERVAL_S);

// ── ABIs ────────────────────────────────────────────────────────────────────

const escrowAbi = [
  { type: 'function', name: 'collect',  stateMutability: 'nonpayable', inputs: [{ name: 'asset', type: 'address' }], outputs: [] },
  { type: 'function', name: 'claimable', stateMutability: 'view',      inputs: [{ name: 'asset', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'forfeit',  stateMutability: 'nonpayable', inputs: [{ name: 'asset', type: 'address' }], outputs: [] },
  { type: 'function', name: 'tokenData', stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{ type: 'tuple', components: [
      { name: 'creator',         type: 'address' },
      { name: 'launchTime',      type: 'uint48'  },
      { name: 'forfeited',       type: 'bool'    },
      { name: 'usdcAccrued',     type: 'uint128' },
      { name: 'usdcClaimed',     type: 'uint128' },
      { name: 'tokenPending',    type: 'uint128' },
      { name: 'recordedRevenue', type: 'uint128' },
      { name: 'numerairePending', type: 'uint128' },
      { name: 'poolId',          type: 'bytes32' },
      { name: 'numeraire',       type: 'address' },
    ]}],
  },
] as const;

const vaultAbi = [
  { type: 'function', name: 'collect',   stateMutability: 'nonpayable', inputs: [{ name: 'asset', type: 'address' }], outputs: [] },
  { type: 'function', name: 'execute',   stateMutability: 'nonpayable',
    inputs: [{ name: 'asset', type: 'address' }, { name: 'usdcIn', type: 'uint256' }, { name: 'minTokenOut', type: 'uint256' }],
    outputs: [] },
  { type: 'function', name: 'assetData', stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{ type: 'tuple', components: [
      { name: 'poolKey',            type: 'tuple', components: [
        { name: 'currency0',  type: 'address' },
        { name: 'currency1',  type: 'address' },
        { name: 'fee',        type: 'uint24'  },
        { name: 'tickSpacing', type: 'int24'  },
        { name: 'hooks',      type: 'address' },
      ]},
      { name: 'poolId',             type: 'bytes32' },
      { name: 'registered',         type: 'bool'    },
      { name: 'balanceUSDC',        type: 'uint128' },
      { name: 'buybackFromRevenue', type: 'uint128' },
      { name: 'buybackFromTrading', type: 'uint128' },
      { name: 'tokenBalance',       type: 'uint128' },
      { name: 'lastExecuteTime',    type: 'uint64'  },
      { name: 'numeraire',          type: 'address' },
    ]}],
  },
] as const;

const routerAbi = [
  { type: 'function', name: 'distribute', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'asset',      stateMutability: 'view',       inputs: [], outputs: [{ type: 'address' }] },
] as const;

const erc20Abi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

const collectAbi = [
  { type: 'function', name: 'collect', stateMutability: 'nonpayable', inputs: [{ name: 'asset', type: 'address' }], outputs: [] },
] as const;

const USDC = USDC_ADDR as Address;

// ── Asset metadata cache ────────────────────────────────────────────────────

interface AssetMeta {
  poolId: `0x${string}`;
  isUsdcCurrency0: boolean;
  /** The numeraire address for this asset (USDC or WMON). */
  numeraire: Address;
  /** True if the asset is paired with WMON instead of USDC. */
  isWmonPair: boolean;
}

const metaCache = new Map<string, AssetMeta>();

async function getAssetMeta(asset: Address): Promise<AssetMeta> {
  const key = asset.toLowerCase();
  const cached = metaCache.get(key);
  if (cached) return cached;

  const data = await publicClient.readContract({
    address: VAULT, abi: vaultAbi, functionName: 'assetData', args: [asset],
  });

  // Determine numeraire from registry (authoritative source)
  const numeraire = await getAssetNumeraire(asset);
  const isWmonPair = numeraire.toLowerCase() === WMON.toLowerCase();

  const meta: AssetMeta = {
    poolId: data.poolId as `0x${string}`,
    isUsdcCurrency0: data.poolKey.currency0.toLowerCase() === USDC.toLowerCase(),
    numeraire,
    isWmonPair,
  };
  metaCache.set(key, meta);
  return meta;
}

// ── Pending fee helper ──────────────────────────────────────────────────────

/**
 * Get the pending numeraire fees for a specific beneficiary of an asset.
 *
 * collectFees returns TOTAL pool fees regardless of the caller.
 * We multiply by the beneficiary's WAD share (from getShares) to get
 * the per-beneficiary amount: `total * share / WAD`.
 *
 * For USDC-paired tokens, this returns USDC amount.
 * For WMON-paired tokens, this returns WMON amount.
 */
async function getPendingNumeraire(asset: Address, beneficiary: Address): Promise<bigint> {
  const meta = await getAssetMeta(asset);
  const { fees0, fees1 } = await simulatePendingFees(meta.poolId, beneficiary);

  // Numeraire is always one side of the pool.
  // For USDC pairs: numeraire side has USDC fees.
  // For WMON pairs: numeraire side has WMON fees.
  let totalNumeraire: bigint;
  if (meta.isWmonPair) {
    // WMON pair: WMON is the numeraire currency in the pool
    const wmonIsCurrency0 = !meta.isUsdcCurrency0; // if USDC is not currency0, then WMON is currency0 ... but actually for WMON pairs, USDC is not in the pool at all
    // For WMON pairs, currency0/currency1 is WMON and TOKEN (sorted by address).
    // We need to figure out which side is WMON.
    totalNumeraire = fees0 + fees1; // Conservative: take total, share math handles per-beneficiary
    // Actually, we should check which side is the numeraire (WMON).
    // The pool has WMON and TOKEN. We check if WMON is currency0.
    // Re-read from pool key for accuracy:
    const data = await publicClient.readContract({
      address: VAULT, abi: vaultAbi, functionName: 'assetData', args: [asset],
    });
    const wmonIsCurr0 = data.poolKey.currency0.toLowerCase() === WMON.toLowerCase();
    totalNumeraire = wmonIsCurr0 ? fees0 : fees1;
  } else {
    // USDC pair: original behavior
    totalNumeraire = meta.isUsdcCurrency0 ? fees0 : fees1;
  }

  if (totalNumeraire === 0n) return 0n;
  const share = await getBeneficiaryShare(meta.poolId, beneficiary);
  if (share === 0n) return 0n;
  return (totalNumeraire * share) / WAD;
}

// ── Collect cadence tracker ─────────────────────────────────────────────────

const lastCollectTime = new Map<string, number>();

/**
 * Pure decision: should we collect for this beneficiary?
 * Exported for testing.
 */
export function shouldCollect(
  pendingUsdc: bigint,
  lastTs: number,
  nowS: number,
  threshold: bigint,
  intervalS: number,
): { send: boolean; reason: string } {
  if (lastTs > 0) {
    const elapsed = nowS - lastTs;
    if (elapsed < intervalS) {
      return {
        send: false,
        reason: `cadence: ${elapsed}s elapsed < ${intervalS}s interval`,
      };
    }
  }
  if (pendingUsdc < threshold) {
    return {
      send: false,
      reason: `pending ${formatUnits(pendingUsdc, 6)} USDC < min ${formatUnits(threshold, 6)}`,
    };
  }
  return {
    send: true,
    reason: `pending ${formatUnits(pendingUsdc, 6)} USDC >= min ${formatUnits(threshold, 6)}`,
  };
}

// ── Job: distribute ─────────────────────────────────────────────────────────

/** Call distribute() on the RevenueRouter if it holds USDC above threshold. */
export async function jobDistribute(router: Address): Promise<void> {
  const tag = `distribute:${router}`;
  const balance = await publicClient.readContract({
    address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [router],
  });
  if (balance < minDistributeUsdc) {
    console.log(`[${tag}] SKIP — ${formatUnits(balance, 6)} USDC < min ${formatUnits(minDistributeUsdc, 6)}`);
    return;
  }
  console.log(`[${tag}] SEND — ${formatUnits(balance, 6)} USDC`);
  try {
    const { hash } = await sendTx({ address: router, abi: routerAbi, functionName: 'distribute', args: [] });
    log(tag, `${formatUnits(balance, 6)} USDC`, hash);
    if (!DRY_RUN) await publicClient.waitForTransactionReceipt({ hash });
  } catch (e) {
    if (e instanceof SpendGuardError) throw e;
    logError(tag, 'distribute', e);
  }
}

// ── Job: buyback ────────────────────────────────────────────────────────────

/**
 * Execute buyback for `asset`.
 * Skips if balance < threshold, cap window active, cooldown not elapsed,
 * or asset is WMON-paired (vault reverts BuybackNotAvailable for WMON pairs).
 */
export async function jobBuyback(asset: Address): Promise<void> {
  const tag = `buyback:${asset}`;

  // Skip WMON-paired tokens — BuybackVault.execute() reverts BuybackNotAvailable
  const meta = await getAssetMeta(asset);
  if (meta.isWmonPair) {
    console.log(`[${tag}] SKIP — WMON-paired token, buyback not available`);
    return;
  }

  const data = await publicClient.readContract({
    address: VAULT, abi: vaultAbi, functionName: 'assetData', args: [asset],
  });
  const balance = data.balanceUSDC;

  if (balance < minBuybackUsdc) {
    console.log(`[${tag}] SKIP — ${formatUnits(balance, 6)} USDC < min ${formatUnits(minBuybackUsdc, 6)}`);
    return;
  }

  const block = await publicClient.getBlock();
  const capEnd = await publicClient.readContract({
    address: asset,
    abi: [{ type: 'function', name: 'balanceLimitEnd', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint48' }] }],
    functionName: 'balanceLimitEnd',
  });
  if (block.timestamp < capEnd) {
    console.log(`[${tag}] SKIP — cap window active until ${capEnd}`);
    return;
  }

  const lastExecute = data.lastExecuteTime;
  const COOLDOWN_S  = 600n; // 10 minutes (matches AstralaunchConstants.BUYBACK_MIN_INTERVAL)
  if (block.timestamp < lastExecute + COOLDOWN_S) {
    console.log(`[${tag}] SKIP — cooldown, next at ${lastExecute + COOLDOWN_S}`);
    return;
  }

  const usdcIn = balance > MAX_BUYBACK_PER_CALL_USDC ? MAX_BUYBACK_PER_CALL_USDC : balance;
  console.log(`[${tag}] SEND — ${formatUnits(usdcIn, 6)} USDC`);
  try {
    const { hash } = await sendTx({ address: VAULT, abi: vaultAbi, functionName: 'execute', args: [asset, usdcIn, 0n] });
    log(tag, `${formatUnits(usdcIn, 6)} USDC`, hash);
    if (!DRY_RUN) await publicClient.waitForTransactionReceipt({ hash });
  } catch (e) {
    if (e instanceof SpendGuardError) throw e;
    logError(tag, 'execute', e);
  }
}

// ── Job: collect (all three beneficiaries) ──────────────────────────────────

async function collectBeneficiary(
  asset: Address,
  beneficiary: Address,
  name: string,
): Promise<void> {
  const tag = `collect:${name}:${asset}`;
  const cadenceKey = `${beneficiary}:${asset}`.toLowerCase();
  const nowS = Math.floor(Date.now() / 1000);
  const lastTs = lastCollectTime.get(cadenceKey) ?? 0;

  const meta = await getAssetMeta(asset);
  const pendingNumeraire = await getPendingNumeraire(asset, beneficiary);

  // For WMON-paired tokens, we still collect (fees come as WMON + asset tokens).
  // The threshold check uses the raw numeraire amount. For WMON pairs the threshold
  // comparison is approximate (WMON amount vs USDC threshold) — acceptable since
  // WMON value is roughly similar to USDC in order of magnitude, and we want to
  // collect fees regardless to avoid them accumulating.
  const effectiveThreshold = meta.isWmonPair
    ? parseUnits('0.001', 18) // ~0.001 WMON threshold for WMON pairs (low bar, just avoid dust)
    : minCollectUsdc;
  const decimals = meta.isWmonPair ? 18 : 6;
  const symbol = meta.isWmonPair ? 'WMON' : 'USDC';

  const decision = shouldCollectNumeraire(pendingNumeraire, lastTs, nowS, effectiveThreshold, collectIntervalS, decimals, symbol);

  if (!decision.send) {
    console.log(`[${tag}] SKIP — ${decision.reason}`);
    return;
  }

  console.log(`[${tag}] SEND — ${decision.reason}${meta.isWmonPair ? ' (WMON pair)' : ''}`);
  try {
    const { hash } = await sendTx({ address: beneficiary, abi: collectAbi, functionName: 'collect', args: [asset] });
    log(tag, `${formatUnits(pendingNumeraire, decimals)} ${symbol}`, hash);
    if (!DRY_RUN) {
      await publicClient.waitForTransactionReceipt({ hash });
      lastCollectTime.set(cadenceKey, nowS);
    }
  } catch (e) {
    if (e instanceof SpendGuardError) throw e;
    logError(tag, name, e);
  }
}

/**
 * Numeraire-aware collect decision. Same logic as shouldCollect but with
 * configurable decimals and symbol for logging.
 */
function shouldCollectNumeraire(
  pending: bigint,
  lastTs: number,
  nowS: number,
  threshold: bigint,
  intervalS: number,
  decimals: number,
  symbol: string,
): { send: boolean; reason: string } {
  if (lastTs > 0) {
    const elapsed = nowS - lastTs;
    if (elapsed < intervalS) {
      return {
        send: false,
        reason: `cadence: ${elapsed}s elapsed < ${intervalS}s interval`,
      };
    }
  }
  if (pending < threshold) {
    return {
      send: false,
      reason: `pending ${formatUnits(pending, decimals)} ${symbol} < min ${formatUnits(threshold, decimals)}`,
    };
  }
  return {
    send: true,
    reason: `pending ${formatUnits(pending, decimals)} ${symbol} >= min ${formatUnits(threshold, decimals)}`,
  };
}

/** Collect trading fees for all three beneficiaries (with pre-checks). */
export async function jobCollectAll(asset: Address): Promise<void> {
  await collectBeneficiary(asset, ESCROW, 'escrow');
  await collectBeneficiary(asset, VAULT, 'vault');
  await collectBeneficiary(asset, PLATFORM_FEE_RECEIVER, 'pfr');
}

// ── Job: forfeit ────────────────────────────────────────────────────────────

/** Forfeit unclaimed escrow for `asset` if past the 365-day window. */
export async function jobForfeit(asset: Address): Promise<void> {
  const tag = `forfeit:${asset}`;
  const data = await publicClient.readContract({
    address: ESCROW, abi: escrowAbi, functionName: 'tokenData', args: [asset],
  });
  if (data.forfeited) { console.log(`[${tag}] SKIP — already forfeited`); return; }

  const block = await publicClient.getBlock();
  const forfeitAt = BigInt(data.launchTime) + BigInt(FORFEIT_DELAY_S);
  if (block.timestamp < forfeitAt) {
    console.log(`[${tag}] SKIP — window opens at ${forfeitAt} (now ${block.timestamp})`);
    return;
  }

  const unclaimed = data.usdcAccrued - data.usdcClaimed;
  if (unclaimed === 0n) { console.log(`[${tag}] SKIP — nothing to forfeit`); return; }

  console.log(`[${tag}] SEND — ${formatUnits(unclaimed, 6)} USDC to vault`);
  try {
    const { hash } = await sendTx({ address: ESCROW, abi: escrowAbi, functionName: 'forfeit', args: [asset] });
    log(tag, `${formatUnits(unclaimed, 6)} USDC forfeited to vault`, hash);
    if (!DRY_RUN) await publicClient.waitForTransactionReceipt({ hash });
  } catch (e) {
    if (e instanceof SpendGuardError) throw e;
    logError(tag, 'forfeit', e);
  }
}

// ── Job: O4 swap WMON → USDC (stub) ────────────────────────────────────────

/**
 * O4: Swap accumulated WMON numeraire fees to USDC for FeeEscrow.
 *
 * For WMON-paired tokens, FeeEscrow accumulates WMON in `numerairePending`.
 * This job should swap that WMON to USDC via a DEX and call
 * FeeEscrow.creditUsdcFromSwap(asset, wmonUsed, usdcReceived).
 *
 * TODO: Implement once a USDC/WMON v4 pool (or alternative DEX route) is available.
 * For now, this logs the pending WMON amount and skips. The keeper operator
 * can handle WMON → USDC swaps manually and call creditUsdcFromSwap.
 */
export async function jobSwapWmonToUsdc(asset: Address): Promise<void> {
  const tag = `o4-swap:${asset}`;
  const meta = await getAssetMeta(asset);

  if (!meta.isWmonPair) {
    // Not a WMON pair — nothing to swap
    return;
  }

  try {
    const data = await publicClient.readContract({
      address: ESCROW, abi: escrowAbi, functionName: 'tokenData', args: [asset],
    });
    const numerairePending = data.numerairePending;

    if (numerairePending === 0n) {
      return; // No pending WMON to swap
    }

    // TODO: Once a USDC/WMON pool is available on Monad, implement:
    //   1. Approve WMON to the swap router
    //   2. Swap WMON → USDC via PoolManager.unlock() or Universal Router
    //   3. Call FeeEscrow.creditUsdcFromSwap(asset, wmonUsed, usdcReceived)
    //
    // For now, just log the pending amount for manual handling.
    console.log(`[${tag}] PENDING — ${formatUnits(numerairePending, 18)} WMON awaiting swap to USDC (manual handling required)`);
  } catch (e) {
    logError(tag, 'swapWmonToUsdc', e);
  }
}

// ── Orchestrator ────────────────────────────────────────────────────────────

/**
 * Run all jobs for one asset in priority order:
 *   distribute, buyback (high value, use existing USDC) →
 *   collect (expensive, may have nothing) →
 *   forfeit (rare) →
 *   O4 swap (WMON → USDC, stub for now)
 */
export async function runAssetJobs(asset: Address, router: Address): Promise<void> {
  await jobDistribute(router);
  await jobBuyback(asset);
  await jobCollectAll(asset);
  await jobForfeit(asset);
  await jobSwapWmonToUsdc(asset);
}

// ── PlatformFeeReceiver ABI (for telegram monitors) ────────────────────────

const pfrAbi = [
  { type: 'function', name: 'collect', stateMutability: 'nonpayable', inputs: [{ name: 'asset', type: 'address' }], outputs: [] },
  { type: 'function', name: 'pendingTreasury', stateMutability: 'view', inputs: [],
    outputs: [{ name: 'proposed', type: 'address' }, { name: 'executableAt', type: 'uint256' }] },
  { type: 'function', name: 'pendingAdmin', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

const registryAdminAbi = [
  { type: 'function', name: 'pendingAdmin', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

export { pfrAbi, registryAdminAbi };

// ── Test helpers ────────────────────────────────────────────────────────────

export function _resetCadenceForTest(): void {
  lastCollectTime.clear();
  metaCache.clear();
}

export function _setCadenceForTest(beneficiary: string, asset: string, ts: number): void {
  lastCollectTime.set(`${beneficiary}:${asset}`.toLowerCase(), ts);
}

export function _getConfig() {
  return { minCollectUsdc, minDistributeUsdc, minBuybackUsdc, collectIntervalS };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function log(tag: string, detail: string, hash: string) {
  console.log(JSON.stringify({ tag, detail, hash, ts: new Date().toISOString() }));
}

function logError(tag: string, step: string, err: unknown) {
  console.error(JSON.stringify({ tag, step, error: String(err), ts: new Date().toISOString() }));
}

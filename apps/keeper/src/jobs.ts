/**
 * Keeper on-chain jobs (SPEC §15).
 *
 * Job order per asset (by usefulness — distribute/buyback first so a spend
 * guard hit from expensive collects never blocks them):
 *   1. distribute — forward revenue from routers
 *   2. buyback   — swap accumulated USDC → token and burn
 *   3. collect   — pull Doppler trading fees (escrow + vault + PFR)
 *   4. forfeit   — move unclaimed escrow to vault after 365 days
 *
 * Collects are gated by:
 *   - Pending fee pre-check (simulateContract on initializer.collectFees)
 *   - Cadence limit: at most once per COLLECT_INTERVAL_S per beneficiary per asset
 *   - Threshold: pending USDC must be >= MIN_COLLECT_USDC
 */
import { formatUnits, parseUnits, type Address } from 'viem';
import {
  publicClient, ESCROW, VAULT, PLATFORM_FEE_RECEIVER,
  sendTx, DRY_RUN, simulatePendingFees,
} from './chain.js';
import {
  KEEPER_MIN_COLLECT_USDC,
  KEEPER_MIN_DISTRIBUTE_USDC,
  KEEPER_MIN_BUYBACK_USDC,
  MAX_BUYBACK_PER_CALL_USDC,
  FORFEIT_DELAY_S,
  COLLECT_INTERVAL_S as DEFAULT_COLLECT_INTERVAL_S,
  USDC as USDC_ADDR,
} from '@revpad/shared';
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
      { name: 'poolId',          type: 'bytes32' },
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
}

const metaCache = new Map<string, AssetMeta>();

async function getAssetMeta(asset: Address): Promise<AssetMeta> {
  const key = asset.toLowerCase();
  const cached = metaCache.get(key);
  if (cached) return cached;

  const data = await publicClient.readContract({
    address: VAULT, abi: vaultAbi, functionName: 'assetData', args: [asset],
  });
  const meta: AssetMeta = {
    poolId: data.poolId as `0x${string}`,
    isUsdcCurrency0: data.poolKey.currency0.toLowerCase() === USDC.toLowerCase(),
  };
  metaCache.set(key, meta);
  return meta;
}

// ── Pending fee helper ──────────────────────────────────────────────────────

async function getPendingUsdc(asset: Address, beneficiary: Address): Promise<bigint> {
  const meta = await getAssetMeta(asset);
  const { fees0, fees1 } = await simulatePendingFees(meta.poolId, beneficiary);
  return meta.isUsdcCurrency0 ? fees0 : fees1;
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
 * Skips if balance < threshold, cap window active, or cooldown not elapsed.
 */
export async function jobBuyback(asset: Address): Promise<void> {
  const tag = `buyback:${asset}`;
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
  const COOLDOWN_S  = 600n; // 10 minutes (matches RevpadConstants.BUYBACK_MIN_INTERVAL)
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

  const pendingUsdc = await getPendingUsdc(asset, beneficiary);
  const decision = shouldCollect(pendingUsdc, lastTs, nowS, minCollectUsdc, collectIntervalS);

  if (!decision.send) {
    console.log(`[${tag}] SKIP — ${decision.reason}`);
    return;
  }

  console.log(`[${tag}] SEND — ${decision.reason}`);
  try {
    const { hash } = await sendTx({ address: beneficiary, abi: collectAbi, functionName: 'collect', args: [asset] });
    log(tag, `${formatUnits(pendingUsdc, 6)} USDC`, hash);
    if (!DRY_RUN) {
      await publicClient.waitForTransactionReceipt({ hash });
      lastCollectTime.set(cadenceKey, nowS);
    }
  } catch (e) {
    if (e instanceof SpendGuardError) throw e;
    logError(tag, name, e);
  }
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

// ── Orchestrator ────────────────────────────────────────────────────────────

/**
 * Run all jobs for one asset in priority order:
 *   distribute, buyback (high value, use existing USDC) →
 *   collect (expensive, may have nothing) →
 *   forfeit (rare)
 */
export async function runAssetJobs(asset: Address, router: Address): Promise<void> {
  await jobDistribute(router);
  await jobBuyback(asset);
  await jobCollectAll(asset);
  await jobForfeit(asset);
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

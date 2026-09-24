/**
 * Keeper on-chain jobs (SPEC §11, CLAUDE.md Task 3).
 *
 * Jobs run per registered asset:
 *   collect   — pull trading fees (escrow + vault share) from Doppler initializer.
 *   distribute — call RevenueRouter.distribute() on routers with pending USDC.
 *   buyback   — swap accumulated USDC → token and burn (after cap window, cooldown).
 *   forfeit   — move unclaimed escrow to vault after 365 days.
 *
 * Idempotent: each job checks preconditions on-chain before sending a tx.
 * Tx hashes are logged to stdout as JSON for easy ingestion.
 */
import { formatUnits, type Address } from 'viem';
import { publicClient, ESCROW, VAULT, PLATFORM_FEE_RECEIVER, sendTx } from './chain.js';
import {
  MIN_BUYBACK_USDC,
  MAX_BUYBACK_PER_CALL_USDC,
  FORFEIT_DELAY_S,
} from '@revpad/shared';

// ── ABIs (minimal, sourced from compiled contracts) ───────────────────────────

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

const USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603' as Address;

// ── Job runners ────────────────────────────────────────────────────────────────

/** Pull Doppler trading fees into escrow and vault for this asset. */
export async function jobCollect(asset: Address): Promise<void> {
  const tag = `collect:${asset}`;
  // Collect escrow share
  try {
    const hash = await sendTx({ address: ESCROW, abi: escrowAbi, functionName: 'collect', args: [asset] });
    log(tag, 'escrow', hash);
    await publicClient.waitForTransactionReceipt({ hash });
  } catch (e) {
    logError(tag, 'escrow', e);
  }
  // Collect vault share
  try {
    const hash = await sendTx({ address: VAULT, abi: vaultAbi, functionName: 'collect', args: [asset] });
    log(tag, 'vault', hash);
    await publicClient.waitForTransactionReceipt({ hash });
  } catch (e) {
    logError(tag, 'vault', e);
  }
}

/** Call distribute() on the RevenueRouter for this asset if it holds USDC. */
export async function jobDistribute(router: Address): Promise<void> {
  const tag = `distribute:${router}`;
  const balance = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [router] });
  if (balance === 0n) { console.log(`[${tag}] skip — no USDC`); return; }
  try {
    const hash = await sendTx({ address: router, abi: routerAbi, functionName: 'distribute', args: [] });
    log(tag, `${formatUnits(balance, 6)} USDC`, hash);
    await publicClient.waitForTransactionReceipt({ hash });
  } catch (e) {
    logError(tag, 'distribute', e);
  }
}

/**
 * Execute buyback for `asset`.
 * Skips if:
 *   - balance < MIN_BUYBACK_USDC
 *   - balance cap window still active (CapWindowActive)
 *   - min interval not elapsed (CooldownActive)
 *
 * usdcIn = min(balance, MAX_BUYBACK_PER_CALL_USDC).
 * minTokenOut = 0 for now (TODO: use v4 Quoter for slippage protection).
 */
export async function jobBuyback(asset: Address): Promise<void> {
  const tag = `buyback:${asset}`;
  const data = await publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: 'assetData', args: [asset] });
  const balance = data.balanceUSDC;

  if (balance < MIN_BUYBACK_USDC) {
    console.log(`[${tag}] skip — only ${formatUnits(balance, 6)} USDC (< min ${formatUnits(MIN_BUYBACK_USDC, 6)})`);
    return;
  }

  const block = await publicClient.getBlock();
  const capEnd = await publicClient.readContract({
    address: asset,
    abi: [{ type: 'function', name: 'balanceLimitEnd', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint48' }] }],
    functionName: 'balanceLimitEnd',
  });
  if (block.timestamp < capEnd) {
    console.log(`[${tag}] skip — balance cap window active until ${capEnd}`);
    return;
  }

  const lastExecute = data.lastExecuteTime;
  const COOLDOWN_S  = 600n; // 10 minutes (matches RevpadConstants.BUYBACK_MIN_INTERVAL)
  if (block.timestamp < lastExecute + COOLDOWN_S) {
    console.log(`[${tag}] skip — cooldown, next at ${lastExecute + COOLDOWN_S}`);
    return;
  }

  const usdcIn = balance > MAX_BUYBACK_PER_CALL_USDC ? MAX_BUYBACK_PER_CALL_USDC : balance;
  try {
    const hash = await sendTx({ address: VAULT, abi: vaultAbi, functionName: 'execute', args: [asset, usdcIn, 0n] });
    log(tag, `${formatUnits(usdcIn, 6)} USDC`, hash);
    await publicClient.waitForTransactionReceipt({ hash });
  } catch (e) {
    logError(tag, 'execute', e);
  }
}

/** Forfeit unclaimed escrow for `asset` if past the 365-day window. */
export async function jobForfeit(asset: Address): Promise<void> {
  const tag = `forfeit:${asset}`;
  const data = await publicClient.readContract({ address: ESCROW, abi: escrowAbi, functionName: 'tokenData', args: [asset] });
  if (data.forfeited) { console.log(`[${tag}] skip — already forfeited`); return; }

  const block = await publicClient.getBlock();
  const forfeitAt = BigInt(data.launchTime) + BigInt(FORFEIT_DELAY_S);
  if (block.timestamp < forfeitAt) {
    console.log(`[${tag}] skip — forfeit window opens at ${forfeitAt} (now ${block.timestamp})`);
    return;
  }

  const unclaimed = data.usdcAccrued - data.usdcClaimed;
  if (unclaimed === 0n) { console.log(`[${tag}] skip — nothing to forfeit`); return; }

  try {
    const hash = await sendTx({ address: ESCROW, abi: escrowAbi, functionName: 'forfeit', args: [asset] });
    log(tag, `${formatUnits(unclaimed, 6)} USDC forfeited to vault`, hash);
    await publicClient.waitForTransactionReceipt({ hash });
  } catch (e) {
    logError(tag, 'forfeit', e);
  }
}

// ── PlatformFeeReceiver ABI ──────────────────────────────────────────────────

const pfrAbi = [
  { type: 'function', name: 'collect', stateMutability: 'nonpayable', inputs: [{ name: 'asset', type: 'address' }], outputs: [] },
  { type: 'function', name: 'pendingTreasury', stateMutability: 'view', inputs: [],
    outputs: [{ name: 'proposed', type: 'address' }, { name: 'executableAt', type: 'uint256' }] },
] as const;

/** Collect platform trading-fee share via PlatformFeeReceiver and forward to treasury. */
export async function jobCollectPlatformFee(asset: Address): Promise<void> {
  const tag = `collectPFR:${asset}`;
  try {
    const hash = await sendTx({ address: PLATFORM_FEE_RECEIVER, abi: pfrAbi, functionName: 'collect', args: [asset] });
    log(tag, 'pfr', hash);
    await publicClient.waitForTransactionReceipt({ hash });
  } catch (e) {
    logError(tag, 'pfr', e);
  }
}

export { pfrAbi };

// ── Helpers ────────────────────────────────────────────────────────────────────

function log(tag: string, detail: string, hash: string) {
  console.log(JSON.stringify({ tag, detail, hash, ts: new Date().toISOString() }));
}

function logError(tag: string, step: string, err: unknown) {
  console.error(JSON.stringify({ tag, step, error: String(err), ts: new Date().toISOString() }));
}

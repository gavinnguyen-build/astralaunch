/**
 * Value-aware collect gate (pure, no chain access).
 *
 * A collect only pays off when the fees it moves are worth clearly more than its gas. On mainnet one
 * collect cost 0.141 MON gas to move 0.106 WMON. The pending numeraire value is converted to MON:
 *   - WMON pair: 1 WMON = 1 MON
 *   - USDC pair: via the Chainlink MON/USD feed (8 decimals): wei = usdc(6dp) × 1e20 / price
 * and the collect is sent only when value ≥ COLLECT_MIN_VALUE_MULTIPLE × estimated gas cost (gas limit ×
 * price, since Monad bills the limit). Asset-token fees are not valued (conservative). Without a usable
 * price a USDC-pair collect is skipped: the fees stay claimable for a later tick.
 */
import { formatEther, formatUnits } from 'viem';

export const DEFAULT_COLLECT_MIN_VALUE_MULTIPLE = 5;

/** COLLECT_MIN_VALUE_MULTIPLE → basis points (5 → 50_000). Blank = default; must be a positive number. */
export function parseValueMultipleBps(raw: string | undefined): bigint {
  if (raw === undefined || raw.trim() === '') return BigInt(DEFAULT_COLLECT_MIN_VALUE_MULTIPLE * 10_000);
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`COLLECT_MIN_VALUE_MULTIPLE must be a positive number, got "${raw}"`);
  return BigInt(Math.round(n * 10_000));
}

export interface MonUsd { price: bigint; updatedAt: bigint }

/** Pending numeraire in MON wei, or null when a USDC amount cannot be priced. */
export function pendingValueMon(pending: bigint, isWmonPair: boolean, monUsd: MonUsd | null, nowS: bigint, maxStalenessS: bigint): { wei: bigint | null; note: string } {
  if (isWmonPair) return { wei: pending, note: 'WMON 1:1' };
  if (!monUsd) return { wei: null, note: 'MON/USD price unavailable' };
  if (monUsd.price <= 0n) return { wei: null, note: `MON/USD price invalid (${monUsd.price})` };
  if (nowS - monUsd.updatedAt > maxStalenessS) return { wei: null, note: `MON/USD price stale (${nowS - monUsd.updatedAt}s old > ${maxStalenessS}s)` };
  return { wei: (pending * 10n ** 20n) / monUsd.price, note: `MON/USD $${formatUnits(monUsd.price, 8)}` };
}

export function collectValueGate(args: {
  pending: bigint; isWmonPair: boolean; monUsd: MonUsd | null; nowS: bigint; maxStalenessS: bigint;
  gasCostWei: bigint; multipleBps: bigint;
}): { send: boolean; reason: string } {
  const sym = args.isWmonPair ? 'WMON' : 'USDC';
  const amt = `${formatUnits(args.pending, args.isWmonPair ? 18 : 6)} ${sym}`;
  const need = (args.gasCostWei * args.multipleBps) / 10_000n;
  const mult = `${Number(args.multipleBps) / 10_000}×`;
  const v = pendingValueMon(args.pending, args.isWmonPair, args.monUsd, args.nowS, args.maxStalenessS);
  if (v.wei === null) return { send: false, reason: `value: ${amt} cannot be valued (${v.note}); gas ≈ ${formatEther(args.gasCostWei)} MON` };
  const cmp = `pending ${amt} ≈ ${formatEther(v.wei)} MON (${v.note}) vs ${mult} gas ${formatEther(args.gasCostWei)} MON = ${formatEther(need)} MON`;
  return v.wei >= need ? { send: true, reason: `value ok: ${cmp}` } : { send: false, reason: `value: ${cmp}` };
}

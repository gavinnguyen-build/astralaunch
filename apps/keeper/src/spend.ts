/**
 * Keeper spend guard — rolling 24h MON budget tracker.
 *
 * Prevents the keeper from draining its wallet by:
 *   - Enforcing a maximum MON spend per 24h rolling window
 *   - Refusing to send when wallet balance is too low
 *   - Alerting on single expensive transactions
 */
import { parseEther, formatEther } from 'viem';
import {
  MAX_MON_PER_DAY_WEI,
  MIN_MON_BALANCE_WEI,
  SINGLE_TX_ALERT_WEI,
} from '@astralaunch/shared';
import { html, sendTelegramAlert } from './telegram.js';

// ── Config (overridable via env) ──────────────────────────────────────────────

function envBigInt(key: string, fallback: bigint): bigint {
  const v = process.env[key];
  if (!v) return fallback;
  return parseEther(v); // e.g. "0.5" → 0.5 MON in wei
}

export const MAX_MON_PER_DAY  = envBigInt('MAX_MON_PER_DAY',  MAX_MON_PER_DAY_WEI);
export const MIN_MON_BALANCE  = envBigInt('MIN_MON_BALANCE',   MIN_MON_BALANCE_WEI);
export const SINGLE_TX_ALERT  = envBigInt('SINGLE_TX_ALERT',   SINGLE_TX_ALERT_WEI);

// ── Rolling window ────────────────────────────────────────────────────────────

interface SpendEntry { ts: number; mon: bigint }

const spendLog: SpendEntry[] = [];
let lastBlockedAlert = false;

const DAY_MS = 24 * 60 * 60 * 1000;

function pruneOld(now: number): void {
  const cutoff = now - DAY_MS;
  while (spendLog.length > 0 && spendLog[0].ts < cutoff) {
    spendLog.shift();
  }
}

function rollingTotal(): bigint {
  return spendLog.reduce((sum, e) => sum + e.mon, 0n);
}

// ── Public API ────────────────────────────────────────────────────────────────

export class SpendGuardError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SpendGuardError';
  }
}

export interface CanSpendResult {
  ok: boolean;
  reason?: string;
}

/**
 * Check if the keeper can afford to spend `estimatedMon` wei.
 * Call before every sendTx.
 */
export function canSpend(estimatedMon: bigint, walletBalance: bigint): CanSpendResult {
  const now = Date.now();
  pruneOld(now);

  // Check wallet balance
  if (walletBalance < MIN_MON_BALANCE + estimatedMon) {
    return {
      ok: false,
      reason: `wallet balance ${formatEther(walletBalance)} MON < MIN_MON_BALANCE (${formatEther(MIN_MON_BALANCE)}) + tx cost (${formatEther(estimatedMon)})`,
    };
  }

  // Check rolling 24h budget
  const total = rollingTotal();
  if (total + estimatedMon > MAX_MON_PER_DAY) {
    return {
      ok: false,
      reason: `24h spend ${formatEther(total)} + ${formatEther(estimatedMon)} > MAX_MON_PER_DAY (${formatEther(MAX_MON_PER_DAY)})`,
    };
  }

  return { ok: true };
}

/** Record a completed transaction's MON cost. */
export function recordSpend(monCost: bigint): void {
  spendLog.push({ ts: Date.now(), mon: monCost });
}

/**
 * Check spend guard and throw SpendGuardError if blocked.
 * Sends a Telegram alert once per blocked state.
 */
export async function assertCanSpend(estimatedMon: bigint, walletBalance: bigint): Promise<void> {
  const result = canSpend(estimatedMon, walletBalance);
  if (!result.ok) {
    if (!lastBlockedAlert) {
      lastBlockedAlert = true;
      await sendTelegramAlert(html`⚠️ <b>Keeper Spend Guard Blocked</b>\n${result.reason}`);
    }
    throw new SpendGuardError(result.reason!);
  }
  lastBlockedAlert = false;
}

/** Send a Telegram warning if a single tx cost exceeds the alert threshold. */
export async function alertIfExpensive(monCost: bigint, label: string): Promise<void> {
  if (monCost > SINGLE_TX_ALERT) {
    await sendTelegramAlert(
      html`⚠️ <b>Expensive Keeper TX</b>\n${label}: ${formatEther(monCost)} MON (threshold: ${formatEther(SINGLE_TX_ALERT)})`,
    );
  }
}

/** Reset state (for testing). */
export function _resetForTest(): void {
  spendLog.length = 0;
  lastBlockedAlert = false;
}

/** Expose spend log length for testing. */
export function _spendLogSize(): number {
  return spendLog.length;
}

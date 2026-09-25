// Economics constants — source of truth for both TypeScript and Solidity (CLAUDE.md rule 1).
// Any change here must be mirrored in packages/contracts/src/AstralaunchConstants.sol.

// ── Trading fee ────────────────────────────────────────────────────────────────
/** Uniswap v4 fee units: 2% = 20000 (hundredths of a bip). */
export const POOL_FEE = 20_000;
/** Tick spacing for the 2% custom fee tier. */
export const TICK_SPACING = 200;

// ── Beneficiary shares (WAD = 1e18) ───────────────────────────────────────────
export const WAD = 10n ** 18n;
export const DOPPLER_SHARE_WAD  = 5n  * 10n ** 16n; // 0.05
export const CREATOR_SHARE_WAD  = 35n * 10n ** 16n; // 0.35
export const ESCROW_SHARE_WAD   = 20n * 10n ** 16n; // 0.20
export const BUYBACK_SHARE_WAD  = 10n * 10n ** 16n; // 0.10
export const TREASURY_SHARE_WAD = 30n * 10n ** 16n; // 0.30

// ── Service revenue split (bps, out of 10000) ─────────────────────────────────
export const PROVIDER_BPS = 6000;   // 60% to provider (minus costBps)
export const BUYBACK_BPS  = 3000;   // 30% to BuybackVault
export const TREASURY_BPS = 1000;   // 10% to treasury
/** Hosted service cost cap: costBps ≤ 3000, taken from provider share. */
export const MAX_COST_BPS = 3000;

// ── Escrow ─────────────────────────────────────────────────────────────────────
/** Creator escrow unlock: 2000 bps of recorded revenue (20%). */
export const ESCROW_UNLOCK_BPS = 2000;
/** Forfeit unused escrow after 365 days. */
export const FORFEIT_DELAY_S = 365 * 86_400;

// ── Supply ─────────────────────────────────────────────────────────────────────
export const TOTAL_SUPPLY   = 1_000_000_000n * WAD; // 1 billion tokens (18 dec)
export const POOL_TOKENS    = (TOTAL_SUPPLY * 85n) / 100n; // 85%
export const VESTED_TOKENS  = TOTAL_SUPPLY - POOL_TOKENS;  // 15%

// ── Balance cap ───────────────────────────────────────────────────────────────
export const BALANCE_CAP_PCT = 1n; // 1% of supply
export const BALANCE_CAP_NUM = TOTAL_SUPPLY / 100n;

// ── Vesting ────────────────────────────────────────────────────────────────────
export const VESTING_CLIFF_S    = 30  * 86_400; // 30 days
export const VESTING_DURATION_S = 365 * 86_400; // 365 days

// ── Launch pricing (O1 closed) ─────────────────────────────────────────────────
export const INITIAL_MCAP_USD = 2_500; // $2,500 initial FDV — fixed, not user-visible (O1 closed)

// ── Oracle ──────────────────────────────────────────────────────────────────────
export const MAX_ORACLE_STALENESS_S = 3_600; // 1 hour, matches AstralaunchConstants.sol

// ── Treasury change delay ──────────────────────────────────────────────────────
/** Two-step treasury change delay in seconds (48 hours). */
export const TREASURY_CHANGE_DELAY_S = 48 * 3600;

// ── Keeper — gas ──────────────────────────────────────────────────────────────
/** Gas estimate multiplier (Monad bills gas limit). */
export const GAS_BUFFER_BPS = 11_000n; // ×1.1

// ── Keeper — contract constants (mirrored, do not change without Solidity update) ──
/** Maximum USDC per buyback execute() call (6 dec). */
export const MAX_BUYBACK_PER_CALL_USDC = 1_000_000_000n; // 1000 USDC
/** Minimum seconds between consecutive execute() calls per asset (Solidity: BUYBACK_MIN_INTERVAL). */
export const BUYBACK_MIN_INTERVAL_S = 600; // 10 minutes

// ── Keeper — economic thresholds (gas-saving, env-configurable) ──────────────
// These are keeper-side thresholds to avoid sending txs for dust amounts.
// On-chain contracts have their own minimums (RevenueRouter MIN_DISTRIBUTE = 0.5 USDC).
// Keeper thresholds should be >= contract thresholds to avoid wasted gas.
// Origin: chosen so gas cost (~0.1 MON ≈ $0.03 at 100 gwei) is a small fraction
// of the USDC value being processed.  1 USDC ≈ 33× the gas cost.
/** Skip collect if pending USDC for that beneficiary < this (6 dec, env: MIN_COLLECT_USDC). */
export const KEEPER_MIN_COLLECT_USDC = 100_000n; // 0.1 USDC (MON gas ~$0.0003/tx → 333× cost)
/** Skip distribute if router USDC balance < this (6 dec, env: MIN_DISTRIBUTE_USDC). */
export const KEEPER_MIN_DISTRIBUTE_USDC = 100_000n; // 0.1 USDC
/** Skip buyback if vault USDC balance < this (6 dec, env: MIN_BUYBACK_USDC). */
export const KEEPER_MIN_BUYBACK_USDC = 500_000n; // 0.5 USDC (two swaps for WMON pairs → more gas)

// ── Keeper — collect cadence ─────────────────────────────────────────────────
/** Min seconds between collect calls per beneficiary per asset (env: COLLECT_INTERVAL_S). */
export const COLLECT_INTERVAL_S = 21_600; // 6 hours

// ── Keeper — poll intervals ──────────────────────────────────────────────────
/** Default poll interval for keeper (SPEC §15). */
export const KEEPER_DEFAULT_INTERVAL_S = 600; // 10 minutes
/** Minimum poll interval on non-localhost RPC. */
export const KEEPER_MIN_INTERVAL_S = 300; // 5 minutes

// ── Keeper — spend guards ────────────────────────────────────────────────────
const MON = 10n ** 18n;
/** Maximum MON the keeper may spend in a rolling 24h window. */
export const MAX_MON_PER_DAY_WEI  = (MON * 2n) / 10n; // 0.2 MON
/** Minimum wallet balance before keeper refuses to send txs. */
export const MIN_MON_BALANCE_WEI  = (MON * 2n) / 10n; // 0.2 MON
/** Single tx cost above this triggers a Telegram warning. */
export const SINGLE_TX_ALERT_WEI  = (MON * 5n) / 100n; // 0.05 MON

export function withBuffer(gas: bigint): bigint {
  return (gas * GAS_BUFFER_BPS) / 10_000n;
}

// ── Launch fee + rate limit (off-chain only, no contract mirror) ──────────────
/** Launch fee in whole MON, paid natively to LAUNCH_FEE_TREASURY before launching. */
export const LAUNCH_FEE_MON = 10;
/** Launch fee in wei (MON has 18 decimals). A payment of at least this much counts. */
export const LAUNCH_FEE_WEI = BigInt(LAUNCH_FEE_MON) * 10n ** 18n;
/** Max counted (fee-consumed) launches per launcher wallet per rolling window. */
export const LAUNCH_RATE_LIMIT = 3;
/** Rolling window for LAUNCH_RATE_LIMIT, in seconds (24h). */
export const LAUNCH_RATE_WINDOW_S = 86_400;

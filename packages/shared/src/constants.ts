// Economics constants — source of truth for both TypeScript and Solidity (CLAUDE.md rule 1).
// Any change here must be mirrored in packages/contracts/src/RevpadConstants.sol.

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

// ── Launch pricing (open O1 — verified 2026-09-23) ────────────────────────────
export const START_MCAP_USD = 10_000; // $10,000 FDV at launch

// ── Keeper ─────────────────────────────────────────────────────────────────────
/** Gas estimate multiplier (Monad bills gas limit). */
export const GAS_BUFFER_BPS = 11_000n; // ×1.1
/** Minimum USDC to trigger a buyback execute() call (6 dec). */
export const MIN_BUYBACK_USDC = 1_000_000n; // 1 USDC
/** Maximum USDC per buyback execute() call (6 dec). */
export const MAX_BUYBACK_PER_CALL_USDC = 1_000_000_000n; // 1000 USDC
/** Minimum seconds between consecutive execute() calls per asset. */
export const BUYBACK_MIN_INTERVAL_S = 60; // 1 minute cooldown

export function withBuffer(gas: bigint): bigint {
  return (gas * GAS_BUFFER_BPS) / 10_000n;
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  RevpadConstants
/// @notice Single source of truth for all economics constants on the Solidity side.
///         Mirrors `packages/shared/src/constants.ts`. Change only with explicit approval
///         from project lead; update SPEC §0 when changed.
///
/// CLAUDE.md non-negotiable rule #1: these values are fixed for v1.
library RevpadConstants {
    // ── Pool parameters ───────────────────────────────────────────────────────
    /// @dev Uniswap v4 fee units: 20000 = 2 % (hundredths of a bip).
    uint24  constant POOL_FEE      = 20_000;
    int24   constant TICK_SPACING  = 200;

    // ── Revenue split (bps, must sum to 10 000) ───────────────────────────────
    uint256 constant PROVIDER_BPS  = 6_000;
    uint256 constant BUYBACK_BPS   = 3_000;
    uint256 constant TREASURY_BPS  = 1_000;
    uint256 constant MAX_COST_BPS  = 3_000; // hosted service cost cap, taken from provider share

    // ── Escrow ────────────────────────────────────────────────────────────────
    uint256 constant ESCROW_UNLOCK_BPS = 2_000; // USDC per 1 USDC of recorded revenue
    uint256 constant FORFEIT_DELAY     = 365 days;

    // ── Supply ────────────────────────────────────────────────────────────────
    uint256 constant TOTAL_SUPPLY       = 1_000_000_000 * 1e18;    // 1 billion tokens
    uint256 constant POOL_TOKENS_NUM    = 850_000_000  * 1e18;     // 85 %
    uint256 constant VESTED_TOKENS_NUM  = 150_000_000  * 1e18;     // 15 %
    uint256 constant BALANCE_CAP_NUM    = 10_000_000   * 1e18;     // 1 % (= TOTAL_SUPPLY / 100)
    uint256 constant BALANCE_CAP_WINDOW     = 10 minutes; // lower bound (600 s)
    uint256 constant BALANCE_CAP_WINDOW_MAX = 15 minutes; // upper bound (900 s) — enforced after launch-script fix (decisions.md D18)

    // ── Vesting ───────────────────────────────────────────────────────────────
    uint256 constant VESTING_DURATION  = 365 days;
    uint256 constant VESTING_CLIFF     = 30  days;

    // ── Fee beneficiary shares (WAD = 1e18, sum must equal 1e18) ─────────────
    uint256 constant DOPPLER_SHARE_WAD  = 0.05e18; //  5 %
    uint256 constant CREATOR_SHARE_WAD  = 0.35e18; // 35 % (liquid; creator's direct Doppler share)
    uint256 constant ESCROW_SHARE_WAD   = 0.20e18; // 20 %
    uint256 constant BUYBACK_SHARE_WAD  = 0.10e18; // 10 %
    uint256 constant TREASURY_SHARE_WAD = 0.30e18; // 30 %

    // ── Router thresholds ─────────────────────────────────────────────────────
    /// @dev Minimum USDC balance before distribute() does anything (= 0.5 USDC, 6 decimals).
    uint256 constant MIN_DISTRIBUTE = 500_000;

    // ── Buyback vault ─────────────────────────────────────────────────────────
    uint256 constant BUYBACK_MAX_PER_CALL = 100e6;    // 100 USDC per execution
    uint256 constant BUYBACK_MIN_INTERVAL = 10 minutes;

    // ── Gas buffer (Monad bills gas LIMIT, not used) ──────────────────────────
    uint256 constant GAS_BUFFER_BPS = 1_100; // ×1.1 on every estimate (per CLAUDE.md rule 6)

    // ── Wash-check compile-time assertion (CLAUDE.md rule 2) ─────────────────
    // ESCROW_UNLOCK_BPS < 10_000 - PROVIDER_BPS
    // i.e. 2000 < 4000  → expression = 4000 - 2000 - 1 = 1999  (no underflow → compiles)
    // If someone sets ESCROW_UNLOCK_BPS >= 4000, this underflows → compile error.
    uint256 private constant _WASH_ASSERT = (10_000 - PROVIDER_BPS) - ESCROW_UNLOCK_BPS - 1;
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal interface for DopplerERC20V1 (asset token launched via Doppler Airlock).
// Source: whetstone-research/doppler-sdk 1.0.43 ABI, verified on fork.
interface IDopplerERC20V1 {
    // ── ERC-20 ────────────────────────────────────────────────────────────────
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function burn(uint256 amount) external; // burns caller's own balance (confirmed by SPEC §6.4)

    // ── Balance cap ───────────────────────────────────────────────────────────
    /// @notice Maximum tokens any single wallet may hold during the restriction window.
    ///         Set to 1% of supply (1e9 * 1e18 / 100) for Revpad.
    function maxBalanceLimit() external view returns (uint256);

    /// @notice Unix timestamp after which the per-wallet balance cap is lifted (launch + 10 min).
    function balanceLimitEnd() external view returns (uint48);

    // ── Vesting ───────────────────────────────────────────────────────────────
    /// @notice Global vesting start time (equals launch time for Revpad tokens).
    function vestingStart() external view returns (uint256);

    /// @notice Total duration of the vesting schedule (365 days for Revpad).
    function vestingDuration() external view returns (uint256);

    /// @notice Per-schedule cliff and duration.
    /// @param index  Schedule index (0 for the creator schedule on Revpad).
    /// @return cliff    Cliff duration in seconds (30 days for Revpad).
    /// @return duration Total duration in seconds (365 days for Revpad).
    function vestingSchedules(uint256 index)
        external
        view
        returns (uint64 cliff, uint64 duration);
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IFeeEscrow {
    /// @notice Register a new asset. Called by RevpadRegistry once.
    function registerAsset(address asset, address creator, uint48 launchTime, bytes32 poolId) external;

    /// @notice Authorize a RevenueRouter to call recordRevenue. Called by RevpadRegistry.
    function authorizeRouter(address router) external;

    /// @notice Collect trading-fee accruals from the Doppler initializer for `asset`.
    ///         Anyone may call; the escrow itself calls collectFees as the beneficiary.
    function collect(address asset) external;

    /// @notice Called by the asset's RevenueRouter after a distribute().
    ///         Records the full USDC amount distributed so that escrow unlock can be computed.
    function recordRevenue(address asset, uint256 amt) external;

    /// @notice Maximum USDC the creator may claim right now.
    function claimable(address asset) external view returns (uint256);

    /// @notice Creator claims available USDC escrow.
    function claim(address asset) external;

    /// @notice Anyone may call after launchTime + 365 days.
    ///         Moves remaining unclaimed escrow USDC (+ pending token fees) to BuybackVault.
    function forfeit(address asset) external;
}

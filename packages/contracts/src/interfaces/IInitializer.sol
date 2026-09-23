// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Uniswap v4 PoolKey — mirrors the v4-core struct.
struct PoolKey {
    address currency0;  // lower-address token (USDC if USDC < asset, else asset)
    address currency1;  // higher-address token
    uint24  fee;        // e.g. 20000 (2 %)
    int24   tickSpacing;// e.g. 200
    address hooks;      // Doppler multicurve hook address
}

/// @notice Minimal interface for V4ScheduledMulticurveInitializer
/// (0xCe3099B2F07029b086E5e92a1573C5f5A3071783 on Monad mainnet).
// Source: whetstone-research/doppler-sdk 1.0.43 ABI, verified on Monad mainnet fork
// (block 107059291). See docs/decisions.md section B for spike results.
interface IInitializer {
    /// @notice Collect trading-fee accruals for the caller.
    ///         Doppler releases a beneficiary's share **only to the caller**.
    ///         Called by FeeEscrow and BuybackVault on their own behalf.
    /// @param poolId  Uniswap v4 pool identifier (bytes32).
    /// @return fees0  Amount of currency0 collected.
    /// @return fees1  Amount of currency1 collected.
    function collectFees(bytes32 poolId) external returns (uint128 fees0, uint128 fees1);

    /// @notice Returns the WAD share (out of 1e18) allocated to `beneficiary` for `poolId`.
    /// @param poolId      Uniswap v4 pool identifier.
    /// @param beneficiary Address whose share to query.
    function getShares(bytes32 poolId, address beneficiary) external view returns (uint256 shares);

    /// @notice Returns the PoolKey for a given poolId.
    ///         Spike-confirmed: takes bytes32 poolId, NOT asset address.
    ///         See docs/decisions.md Decision D2.
    function getPoolKey(bytes32 poolId) external view returns (PoolKey memory key);

    /// @notice Returns full pool state for a launched asset.
    ///         Fix 1: preferred over getPoolKey(poolId) because it takes the asset address directly.
    ///         See docs/decisions.md Decision D16.
    /// @param asset  The DopplerERC20V1 token address.
    /// @return numeraire  Quote token (USDC on Revpad).
    /// @return status     Doppler pool status enum value (uint8).
    /// @return poolKey    The Uniswap v4 PoolKey for this asset's pool.
    /// @return farTick    Far tick used by the multicurve.
    function getState(address asset)
        external
        view
        returns (
            address numeraire,
            uint8 status,
            PoolKey memory poolKey,
            int24 farTick
        );
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PoolKey} from "./IInitializer.sol";

/// @title  IFeeAdapter
/// @notice Adapter interface for collecting Doppler trading fees from different initializer types.
///         Each allowed initializer in the AstralaunchRegistry has a corresponding IFeeAdapter
///         that normalizes fee collection across initializer versions.
interface IFeeAdapter {
    /// @notice Collect accrued trading fees for the caller's share in `poolId`.
    /// @param poolId  Uniswap v4 pool identifier.
    /// @return fees0  Amount of currency0 collected.
    /// @return fees1  Amount of currency1 collected.
    function collectFees(bytes32 poolId) external returns (uint128 fees0, uint128 fees1);

    /// @notice Returns the WAD share (out of 1e18) allocated to `beneficiary` for `poolId`.
    /// @param poolId       Uniswap v4 pool identifier.
    /// @param beneficiary  Address whose share to query.
    /// @return shares      Share in WAD (1e18 = 100%).
    function getShares(bytes32 poolId, address beneficiary) external view returns (uint256 shares);

    /// @notice Returns the pool state for a given asset.
    /// @param asset  The DopplerERC20V1 token address.
    /// @return numeraire  Quote token address (USDC or WMON).
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

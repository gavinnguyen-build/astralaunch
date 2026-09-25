// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PoolKey} from "./IInitializer.sol";

/// @title  IFeeAdapter
/// @notice Adapter interface for collecting Doppler trading fees from different initializer types.
///         Each allowed initializer in the AstralaunchRegistry has a corresponding IFeeAdapter
///         that normalizes fee collection across initializer versions.
///
///         `collectFeesCall` returns the target + calldata so the beneficiary itself performs the
///         raw `.call()`, preserving its identity as `msg.sender`. This is critical because
///         Doppler pays trading fees **only to the caller** of `collectFees`.
interface IFeeAdapter {
    /// @notice Returns the target address and calldata for a fee-collection call.
    ///         The beneficiary must execute `target.call(data)` itself so that Doppler
    ///         pays fees to the beneficiary (msg.sender == beneficiary).
    /// @param poolId  Uniswap v4 pool identifier.
    /// @return target  The contract to call (e.g. the initializer).
    /// @return data    The encoded calldata (e.g. `abi.encodeCall(IInitializer.collectFees, (poolId))`).
    function collectFeesCall(bytes32 poolId) external view returns (address target, bytes memory data);

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

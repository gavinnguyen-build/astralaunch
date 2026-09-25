// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IFeeAdapter} from "./interfaces/IFeeAdapter.sol";
import {IInitializer, PoolKey} from "./interfaces/IInitializer.sol";

/// @title  InitializerV1Adapter
/// @notice Wraps the V4ScheduledMulticurveInitializer behind the IFeeAdapter interface.
///         `collectFeesCall` returns the target + calldata so the beneficiary calls the
///         initializer directly, preserving msg.sender identity for Doppler fee payouts.
contract InitializerV1Adapter is IFeeAdapter {
    /// @notice The V4ScheduledMulticurveInitializer address.
    address public immutable initializer;

    error ZeroAddress();

    constructor(address _initializer) {
        if (_initializer == address(0)) revert ZeroAddress();
        initializer = _initializer;
    }

    /// @inheritdoc IFeeAdapter
    function collectFeesCall(bytes32 poolId)
        external
        view
        override
        returns (address target, bytes memory data)
    {
        target = initializer;
        data = abi.encodeCall(IInitializer.collectFees, (poolId));
    }

    /// @inheritdoc IFeeAdapter
    function getShares(bytes32 poolId, address beneficiary)
        external
        view
        override
        returns (uint256 shares)
    {
        return IInitializer(initializer).getShares(poolId, beneficiary);
    }

    /// @inheritdoc IFeeAdapter
    function getState(address asset)
        external
        view
        override
        returns (
            address numeraire,
            uint8 status,
            PoolKey memory poolKey,
            int24 farTick
        )
    {
        return IInitializer(initializer).getState(asset);
    }
}

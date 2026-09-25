// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PoolKey} from "./IInitializer.sol";

/// @notice Signed result of a Uniswap v4 swap (currency0 delta, currency1 delta).
///         Positive = PoolManager owes caller; negative = caller owes PoolManager.
type BalanceDelta is int256;

library BalanceDeltaLib {
    function amount0(BalanceDelta bd) internal pure returns (int128) {
        return int128(BalanceDelta.unwrap(bd) >> 128);
    }
    function amount1(BalanceDelta bd) internal pure returns (int128) {
        return int128(BalanceDelta.unwrap(bd));
    }
}

/// @notice Parameters for a v4 pool swap.
struct SwapParams {
    bool    zeroForOne;         // true = sell currency0, buy currency1
    int256  amountSpecified;    // negative = exact-in; positive = exact-out
    uint160 sqrtPriceLimitX96;  // 0 for no limit (use MIN/MAX_SQRT_RATIO ± 1 in practice)
}

/// @notice Minimal IPoolManager interface for Astralaunch contracts (BuybackVault swap path).
/// Uniswap v4 PoolManager: 0x188d586ddcf52439676ca21a244753fa19f9ea8e on Monad mainnet.
interface IPoolManager {
    /// @notice Acquire the lock; calls `IUnlockCallback.unlockCallback(data)` on msg.sender.
    function unlock(bytes calldata data) external returns (bytes memory result);

    /// @notice Execute a swap inside an unlock callback.
    function swap(PoolKey memory key, SwapParams calldata params, bytes calldata hookData)
        external
        returns (BalanceDelta delta);

    /// @notice Settle (pay) any negative balance the caller owes the pool.
    ///         Called after transferring the owed tokens to PoolManager.
    function settle() external payable returns (uint256 paid);

    /// @notice Sync the pool's internal accounting for `currency` to the actual ERC-20 balance.
    ///         Must be called before `settle()` when paying with an ERC-20.
    function sync(address currency) external;

    /// @notice Take tokens the pool owes the caller.
    function take(address currency, address to, uint256 amount) external;
}

/// @notice Implemented by callers of IPoolManager.unlock.
interface IUnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

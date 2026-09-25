// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PoolKey} from "./IInitializer.sol";

uint8 constant SOURCE_REVENUE = 1; // from RevenueRouter.distribute()
uint8 constant SOURCE_TRADING = 2; // from BuybackVault.collect() (trading fees via Doppler)
uint8 constant SOURCE_FORFEIT = 3; // from FeeEscrow.forfeit()

interface IBuybackVault {
    /// @notice Register a new asset. Called by AstralaunchRegistry once.
    /// @param asset     The DopplerERC20V1 token address.
    /// @param poolKey   Uniswap v4 PoolKey for the asset's trading pool.
    /// @param poolId    Uniswap v4 pool identifier.
    /// @param numeraire Quote token for this asset's pool (USDC or WMON).
    function registerAsset(address asset, PoolKey calldata poolKey, bytes32 poolId, address numeraire) external;

    /// @notice Authorize an address to call creditUSDC. Called by AstralaunchRegistry.
    function authorize(address caller) external;

    /// @notice Collect trading-fee accruals from the Doppler initializer for `asset`.
    function collect(address asset) external;

    /// @notice Accounting hook called by RevenueRouter/FeeEscrow after transferring USDC here.
    function creditUSDC(address asset, uint256 amt, uint8 sourceTag) external;

    /// @notice Execute a buyback: swap up to `usdcIn` USDC for `asset` and burn it.
    ///         Permissionless; subject to MAX_PER_CALL and MIN_INTERVAL constraints.
    ///         For USDC pairs: single-hop. For WMON pairs: two-hop via native MON.
    /// @param minMonOut   Minimum native MON output for leg 1 (WMON pairs only; ignored for USDC).
    /// @param minTokenOut Minimum token output from the final swap.
    function execute(address asset, uint256 usdcIn, uint256 minMonOut, uint256 minTokenOut) external;

    /// @notice Burn the vault's accumulated token balance for `asset`.
    function burnTokens(address asset) external;
}

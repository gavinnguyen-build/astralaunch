// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  IPlatformFeeReceiver
/// @notice Singleton that receives the platform's 30% Doppler trading-fee share
///         and forwards collected funds to a changeable treasury address.
///         Used as the beneficiary/integrator/router destination so that treasury
///         changes take effect for ALL tokens (old and new) without touching
///         existing contracts.
///
///         v2: adds guardian role for cancel-only operations and per-token numeraire
///         handling (USDC or WMON pairs).
interface IPlatformFeeReceiver {
    /// @notice Called by AstralaunchRegistry after registering an asset.
    /// @param asset     The DopplerERC20V1 token address.
    /// @param poolId    Uniswap v4 pool identifier.
    /// @param numeraire Quote token for this asset's pool (USDC or WMON).
    function registerAsset(address asset, bytes32 poolId, address numeraire) external;

    /// @notice Permissionless: collect Doppler fees for `asset`, then forward
    ///         all USDC, WMON, and token balances to the current treasury.
    function collect(address asset) external;

    /// @notice Admin proposes a new treasury address (48h delay).
    function proposeTreasury(address newTreasury) external;

    /// @notice Admin accepts a pending treasury change after the delay.
    function acceptTreasury() external;

    /// @notice Admin or guardian cancels a pending treasury proposal.
    function cancelProposal() external;

    /// @notice Returns the pending treasury proposal (zero if none).
    function pendingTreasury() external view returns (address proposed, uint256 executableAt);

    /// @notice The current treasury that receives forwarded funds.
    function treasury() external view returns (address);

    /// @notice Start a two-step admin transfer.
    function transferAdmin(address newAdmin) external;

    /// @notice Accept admin role (only callable by pendingAdmin).
    function acceptAdmin() external;

    /// @notice Admin or guardian cancels a pending admin transfer.
    function cancelAdminTransfer() external;

    /// @notice The pending admin (zero if none).
    function pendingAdmin() external view returns (address);

    /// @notice The guardian address (immutable, set at deploy).
    function guardian() external view returns (address);
}

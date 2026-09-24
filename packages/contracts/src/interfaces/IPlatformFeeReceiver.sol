// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  IPlatformFeeReceiver
/// @notice Singleton that receives the platform's 30% Doppler trading-fee share
///         and forwards collected funds to a changeable treasury address.
///         Used as the beneficiary/integrator/router destination so that treasury
///         changes take effect for ALL tokens (old and new) without touching
///         existing contracts.
interface IPlatformFeeReceiver {
    /// @notice Called by RevpadRegistry after registering an asset.
    function registerAsset(address asset, bytes32 poolId) external;

    /// @notice Permissionless: collect Doppler fees for `asset`, then forward
    ///         all USDC and token balances to the current treasury.
    function collect(address asset) external;

    /// @notice Admin proposes a new treasury address (48h delay).
    function proposeTreasury(address newTreasury) external;

    /// @notice Admin accepts a pending treasury change after the delay.
    function acceptTreasury() external;

    /// @notice Admin cancels a pending treasury proposal.
    function cancelProposal() external;

    /// @notice Returns the pending treasury proposal (zero if none).
    function pendingTreasury() external view returns (address proposed, uint256 executableAt);

    /// @notice The current treasury that receives forwarded funds.
    function treasury() external view returns (address);
}

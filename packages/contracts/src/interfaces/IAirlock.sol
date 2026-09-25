// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal interface for the Doppler Airlock (0x660eAaEdEBc968f8f3694354FA8EC0b4c5Ba8D12).
// Source: whetstone-research/doppler-sdk 1.0.43 ABI, verified on fork.
interface IAirlock {
    /// @notice Returns on-chain data for an asset launched through the Airlock.
    /// @param asset The launched ERC-20 token address.
    /// @return numeraire          The quote token used in the pool (USDC or WMON on Astralaunch).
    /// @return timelock           Timelock contract (unused in Astralaunch v1).
    /// @return governance         Governance factory address (NoOpGovernanceFactory on Astralaunch).
    /// @return liquidityMigrator  Migrator address (NoOpMigrator on Astralaunch).
    /// @return poolInitializer    Initializer address (V4ScheduledMulticurveInitializer on Astralaunch).
    /// @return pool               Pool address / hook address.
    /// @return migrationPool      Post-migration pool (zero for NoOp).
    /// @return numTokensToSell    Tokens in the pool (85% of supply on Astralaunch).
    /// @return totalSupply        Total supply minted (1e27 = 1e9 * 1e18 on Astralaunch).
    /// @return integrator         Integrator address registered with Doppler.
    function getAssetData(address asset)
        external
        view
        returns (
            address numeraire,
            address timelock,
            address governance,
            address liquidityMigrator,
            address poolInitializer,
            address pool,
            address migrationPool,
            uint256 numTokensToSell,
            uint256 totalSupply,
            address integrator
        );
}

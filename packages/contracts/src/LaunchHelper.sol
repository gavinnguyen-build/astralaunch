// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// @notice Doppler Airlock `CreateParams` (doppler-sdk 1.0.43 `airlockAbi.create`, verified on fork).
/// @dev    Built and encoded off-chain by the Doppler SDK (CLAUDE.md rule 11); this contract never
///         constructs or inspects the multicurve encoding. The registry verifies the result on-chain.
struct CreateParams {
    uint256 initialSupply;
    uint256 numTokensToSell;
    address numeraire;
    address tokenFactory;
    bytes tokenFactoryData;
    address governanceFactory;
    bytes governanceFactoryData;
    address poolInitializer;
    bytes poolInitializerData;
    address liquidityMigrator;
    bytes liquidityMigratorData;
    address integrator;
    bytes32 salt;
}

interface IAirlockCreate {
    function create(CreateParams calldata createData)
        external
        returns (address asset, address pool, address governance, address timelock, address migrationPool);
}

interface IRegistryRegister {
    function register(address asset, address creator) external returns (address router);
}

/// @title  LaunchHelper
/// @notice Periphery for a one-transaction launch: Doppler `Airlock.create` → `AstralaunchRegistry.register`
///         → forward the launch fee to the treasury. Changes nothing in the v2 core; anyone can still launch
///         and register directly.
///
///         - `msg.value` must be exactly `launchFee` (fee paid now, `LaunchFeePaid` emitted) or 0 (the
///           launcher already holds an unused off-chain fee receipt; no event). Anything else reverts.
///         - All-or-nothing: if create or register reverts (any config mismatch), the fee is not taken.
///         - Holds no funds and has no admin: the fee is forwarded in the same call, and all four
///           parameters are immutable.
///         - The off-chain launcher (fee receipt owner) is the transaction sender, as for direct launches.
contract LaunchHelper is ReentrancyGuard {
    /// @notice Doppler Airlock.
    IAirlockCreate public immutable airlock;
    /// @notice AstralaunchRegistry (v2).
    IRegistryRegister public immutable registry;
    /// @notice Launch fee recipient (Astralaunch treasury).
    address public immutable treasury;
    /// @notice Launch fee in wei (mirrors LAUNCH_FEE_WEI in packages/shared/src/constants.ts).
    uint256 public immutable launchFee;

    error ZeroAddress();
    error ZeroFee();
    error WrongFee(uint256 sent, uint256 expected);

    /// @notice The launch fee was forwarded to the treasury for `asset`.
    event LaunchFeePaid(address indexed launcher, address indexed asset, uint256 amount);
    /// @notice A token was created through the Airlock and registered.
    event Launched(address indexed launcher, address indexed asset, address indexed creator, address router);

    /// @param airlock_   Doppler Airlock.
    /// @param registry_  AstralaunchRegistry.
    /// @param treasury_  Launch fee recipient.
    /// @param launchFee_ Launch fee in wei (non-zero).
    constructor(address airlock_, address registry_, address treasury_, uint256 launchFee_) {
        if (airlock_ == address(0) || registry_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (launchFee_ == 0) revert ZeroFee();
        airlock = IAirlockCreate(airlock_);
        registry = IRegistryRegister(registry_);
        treasury = treasury_;
        launchFee = launchFee_;
    }

    /// @notice Create the token via the Airlock, register it, and pay the launch fee, in one call.
    /// @param  params  Doppler CreateParams, encoded by the SDK exactly as for a direct `Airlock.create`.
    /// @param  creator On-chain creator (35% fee beneficiary and vesting recipient) passed to `register`.
    /// @return asset   The new token.
    /// @return router  Its RevenueRouter.
    function launch(CreateParams calldata params, address creator)
        external
        payable
        nonReentrant
        returns (address asset, address router)
    {
        uint256 fee = msg.value;
        if (fee != 0 && fee != launchFee) revert WrongFee(fee, launchFee);
        if (creator == address(0)) revert ZeroAddress();

        (asset,,,,) = airlock.create(params);
        router = registry.register(asset, creator);
        emit Launched(msg.sender, asset, creator, router);

        if (fee != 0) {
            SafeTransferLib.safeTransferETH(treasury, fee);
            emit LaunchFeePaid(msg.sender, asset, fee);
        }
    }
}

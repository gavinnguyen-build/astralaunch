// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LibClone} from "solady/utils/LibClone.sol";
import {RevpadConstants as C} from "./RevpadConstants.sol";
import {IAirlock} from "./interfaces/IAirlock.sol";
import {IInitializer, PoolKey} from "./interfaces/IInitializer.sol";
import {IDopplerERC20V1} from "./interfaces/IDopplerERC20V1.sol";
import {IFeeEscrow} from "./interfaces/IFeeEscrow.sol";
import {IBuybackVault} from "./interfaces/IBuybackVault.sol";
import {RevenueRouter} from "./RevenueRouter.sol";

/// @title  RevpadRegistry
/// @notice Verifies a Doppler-launched asset matches the Revpad config, then deploys
///         a RevenueRouter clone and registers the asset in FeeEscrow and BuybackVault.
///
///         Launch flow (SPEC §6.1 / D11):
///         1. Creator launches with Doppler SDK (fixed Revpad config).
///         2. Anyone calls register(asset, creator).
///         3. Registry reads on-chain state and reverts on any mismatch.
///         4. On success: clone deployed, escrow/vault notified, Registered emitted.
///
///         Spike findings (docs/decisions.md):
///         - NOGOV = 0x...dEaD — actual governance address for noOp launches.
///         - DOPPLER_HOOK is constant across all Revpad launches (D16).
///         - getState(asset) returns poolKey directly; poolId computed on-chain (D16).
contract RevpadRegistry {
    // ── Verified Monad mainnet addresses (SPEC §23) ───────────────────────────
    IAirlock     constant AIRLOCK      = IAirlock(0x660eAaEdEBc968f8f3694354FA8EC0b4c5Ba8D12);
    IInitializer constant INITIALIZER  = IInitializer(0xCe3099B2F07029b086E5e92a1573C5f5A3071783);
    address      constant NOMIG        = 0x5F3bA43D44375286296Cb85F1EA2EBfa25dde731;
    // NOGOV = 0x...dEaD: the dead address is the noOp governance instance stored by Airlock
    // (0xb4deE32... is the NoOpGovernanceFactory, not the governance address — see decisions.md D1)
    address      constant NOGOV        = 0x000000000000000000000000000000000000dEaD;
    address      constant USDC         = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address      constant AIRLOCK_OWNER = 0x21E2ce70511e4FE542a97708e89520471DAa7A66;
    // DOPPLER_HOOK is constant across all V4ScheduledMulticurveInitializer launches (D16).
    // Confirmed identical for every token launched in testing (4+ distinct tokens).
    address      constant DOPPLER_HOOK = 0x580ca49389d83b019d07E17e99454f2F218e2dc0;

    // ── Mutable singletons ────────────────────────────────────────────────────
    address       public treasury;
    IFeeEscrow    public feeEscrow;
    IBuybackVault public buybackVault;
    address       public routerImplementation;
    address       public admin;
    bool          public paused;

    // ── Registry state ────────────────────────────────────────────────────────
    mapping(address asset => address router) public routers;

    // ── Errors ────────────────────────────────────────────────────────────────
    error Paused();
    error AlreadyRegistered();
    error NotAdmin();

    // Airlock / initializer mismatch errors
    error WrongInitializer(address got, address expected);
    error WrongMigrator(address got, address expected);
    error WrongGovernance(address got, address expected);
    error WrongNumeraire(address got, address expected);
    error WrongIntegrator(address got, address expected);

    // Pool config mismatch errors
    error WrongPool();  // hook address != DOPPLER_HOOK
    error WrongFee(uint24 got, uint24 expected);
    error WrongTickSpacing(int24 got, int24 expected);
    error WrongPoolCurrencies(); // pool must pair asset ↔ USDC

    // Beneficiary share mismatch errors
    error WrongDopplerShare(uint256 got, uint256 expected);
    error WrongCreatorShare(uint256 got, uint256 expected);
    error WrongEscrowShare(uint256 got, uint256 expected);
    error WrongBuybackShare(uint256 got, uint256 expected);
    error WrongTreasuryShare(uint256 got, uint256 expected);

    // Supply / vesting mismatch errors
    error WrongTotalSupply(uint256 got, uint256 expected);
    error WrongNumTokensToSell(uint256 got, uint256 expected);
    error WrongVestingCliff(uint64 got, uint64 expected);
    error WrongVestingDuration(uint64 got, uint64 expected);
    error WrongVestingAmount(uint256 got, uint256 expected);
    error WrongBalanceCap(uint256 got, uint256 expected);

    // ── Events ────────────────────────────────────────────────────────────────
    event Registered(
        address indexed asset,
        address indexed creator,
        address indexed router,
        bytes32 poolId,
        uint256 timestamp
    );
    event TreasurySet(address oldTreasury, address newTreasury);
    event PauseSet(bool paused);

    // ── Constructor ───────────────────────────────────────────────────────────
    constructor(
        address _treasury,
        address _feeEscrow,
        address _buybackVault,
        address _routerImpl,
        address _admin
    ) {
        treasury             = _treasury;
        feeEscrow            = IFeeEscrow(_feeEscrow);
        buybackVault         = IBuybackVault(_buybackVault);
        routerImplementation = _routerImpl;
        admin                = _admin;
    }

    // ── Register ──────────────────────────────────────────────────────────────
    /// @notice Verify `asset`'s on-chain config and register it on Revpad.
    /// @param asset   The DopplerERC20V1 token address.
    /// @param creator The address that owns the 35 % Doppler fee share and the 150 M vesting.
    ///                Verified by checking getShares(poolId, creator) == CREATOR_SHARE_WAD
    ///                and totalAllocatedOf(creator) == VESTED_TOKENS_NUM.
    /// @return router Address of the newly deployed RevenueRouter clone.
    function register(address asset, address creator)
        external
        returns (address router)
    {
        if (paused) revert Paused();
        if (routers[asset] != address(0)) revert AlreadyRegistered();

        // ── 1. Airlock data ───────────────────────────────────────────────────
        (
            address numeraire,
            ,                     // timelock
            address governance,
            address migrator,
            address poolInitializer,
            ,                     // pool (= asset address for v4 tokens; not used)
            ,                     // migrationPool
            uint256 numTokensToSell,
            uint256 totalSupply,
            address integrator
        ) = AIRLOCK.getAssetData(asset);

        if (poolInitializer != address(INITIALIZER)) revert WrongInitializer(poolInitializer, address(INITIALIZER));
        if (migrator        != NOMIG)                revert WrongMigrator(migrator, NOMIG);
        if (governance      != NOGOV)                revert WrongGovernance(governance, NOGOV);
        if (numeraire       != USDC)                 revert WrongNumeraire(numeraire, USDC);
        if (totalSupply     != C.TOTAL_SUPPLY)       revert WrongTotalSupply(totalSupply, C.TOTAL_SUPPLY);
        if (numTokensToSell != C.POOL_TOKENS_NUM)    revert WrongNumTokensToSell(numTokensToSell, C.POOL_TOKENS_NUM);
        if (integrator      != treasury)             revert WrongIntegrator(integrator, treasury);

        // ── 2. Pool key from getState (Fix 1: getState takes asset, not poolId) ─
        // This eliminates the poolId caller parameter — poolId is now derived on-chain.
        // DOPPLER_HOOK is constant across all V4ScheduledMulticurveInitializer launches (D16).
        (, , PoolKey memory poolKey,) = INITIALIZER.getState(asset);
        if (poolKey.hooks       != DOPPLER_HOOK)   revert WrongPool();
        if (poolKey.fee         != C.POOL_FEE)     revert WrongFee(poolKey.fee, C.POOL_FEE);
        if (poolKey.tickSpacing != C.TICK_SPACING) revert WrongTickSpacing(poolKey.tickSpacing, C.TICK_SPACING);

        // Verify pool currencies are asset ↔ USDC (order depends on address comparison)
        bool c0isUsdc = poolKey.currency0 == USDC && poolKey.currency1 == asset;
        bool c1isUsdc = poolKey.currency1 == USDC && poolKey.currency0 == asset;
        if (!c0isUsdc && !c1isUsdc) revert WrongPoolCurrencies();

        // Compute poolId on-chain from the verified poolKey
        bytes32 poolId = keccak256(abi.encode(poolKey));

        // ── 3. Beneficiary shares ─────────────────────────────────────────────
        _checkShare(poolId, AIRLOCK_OWNER,        C.DOPPLER_SHARE_WAD,  0);
        _checkShare(poolId, creator,              C.CREATOR_SHARE_WAD,  1);
        _checkShare(poolId, address(feeEscrow),   C.ESCROW_SHARE_WAD,   2);
        _checkShare(poolId, address(buybackVault),C.BUYBACK_SHARE_WAD,  3);
        _checkShare(poolId, treasury,             C.TREASURY_SHARE_WAD, 4);

        // ── 4. Token vesting + balance cap ────────────────────────────────────
        IDopplerERC20V1 tok = IDopplerERC20V1(asset);
        (uint64 cliff, uint64 duration) = tok.vestingSchedules(0);
        if (cliff    != uint64(C.VESTING_CLIFF))    revert WrongVestingCliff(cliff, uint64(C.VESTING_CLIFF));
        if (duration != uint64(C.VESTING_DURATION)) revert WrongVestingDuration(duration, uint64(C.VESTING_DURATION));

        // Verify creator is the sole vesting beneficiary with exactly 150 M tokens (Fix 2)
        uint256 allocatedToCreator = tok.totalAllocatedOf(creator);
        if (allocatedToCreator != C.VESTED_TOKENS_NUM)
            revert WrongVestingAmount(allocatedToCreator, C.VESTED_TOKENS_NUM);
        uint256 totalVested = tok.vestedTotalAmount();
        if (totalVested != C.VESTED_TOKENS_NUM)
            revert WrongVestingAmount(totalVested, C.VESTED_TOKENS_NUM);

        // Balance cap: absolute value and window [BALANCE_CAP_WINDOW, BALANCE_CAP_WINDOW_MAX].
        // Both bounds are enforceable after the launch script was fixed to sync Anvil block
        // time before launch so that vestingStart ≈ startTime (see docs/decisions.md D18).
        uint256 cap = tok.maxBalanceLimit();
        if (cap != C.BALANCE_CAP_NUM)
            revert WrongBalanceCap(cap, C.BALANCE_CAP_NUM);
        uint256 capEnd    = uint256(tok.balanceLimitEnd());
        uint256 vestStart = tok.vestingStart();
        uint256 capWindow = capEnd > vestStart ? capEnd - vestStart : 0;
        if (capWindow < C.BALANCE_CAP_WINDOW)
            revert WrongBalanceCap(capWindow, C.BALANCE_CAP_WINDOW);
        if (capWindow > C.BALANCE_CAP_WINDOW_MAX)
            revert WrongBalanceCap(capWindow, C.BALANCE_CAP_WINDOW_MAX);

        // ── 5. Deploy router clone ────────────────────────────────────────────
        router = LibClone.clone(routerImplementation);
        RevenueRouter(router).initialize(
            asset,
            creator,
            creator,       // provider defaults to creator
            address(this),
            address(feeEscrow),
            address(buybackVault),
            treasury
        );

        // ── 6. Register in singletons ─────────────────────────────────────────
        uint48 launchTime = uint48(tok.vestingStart());
        feeEscrow.registerAsset(asset, creator, launchTime, poolId);
        feeEscrow.authorizeRouter(router);
        buybackVault.registerAsset(asset, poolKey, poolId);
        buybackVault.authorize(router);
        buybackVault.authorize(address(feeEscrow));

        routers[asset] = router;

        emit Registered(asset, creator, router, poolId, block.timestamp);
    }

    // ── View ──────────────────────────────────────────────────────────────────
    function isRegistered(address asset) external view returns (bool) {
        return routers[asset] != address(0);
    }

    // ── Admin ─────────────────────────────────────────────────────────────────
    function setTreasury(address newTreasury) external {
        if (msg.sender != admin) revert NotAdmin();
        emit TreasurySet(treasury, newTreasury);
        treasury = newTreasury;
    }

    function setPause(bool _paused) external {
        if (msg.sender != admin) revert NotAdmin();
        paused = _paused;
        emit PauseSet(_paused);
    }

    // ── Internal ──────────────────────────────────────────────────────────────
    /// @dev tag: 0=doppler, 1=creator, 2=escrow, 3=buyback, 4=treasury (used for revert selection)
    function _checkShare(bytes32 poolId, address beneficiary, uint256 expected, uint8 tag) internal view {
        uint256 got = INITIALIZER.getShares(poolId, beneficiary);
        if (got == expected) return;
        if (tag == 0) revert WrongDopplerShare(got, expected);
        if (tag == 1) revert WrongCreatorShare(got, expected);
        if (tag == 2) revert WrongEscrowShare(got, expected);
        if (tag == 3) revert WrongBuybackShare(got, expected);
        revert WrongTreasuryShare(got, expected);
    }
}

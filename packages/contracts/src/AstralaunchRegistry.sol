// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LibClone} from "solady/utils/LibClone.sol";
import {AstralaunchConstants as C} from "./AstralaunchConstants.sol";
import {IAirlock} from "./interfaces/IAirlock.sol";
import {IInitializer, PoolKey} from "./interfaces/IInitializer.sol";
import {IFeeAdapter} from "./interfaces/IFeeAdapter.sol";
import {IDopplerERC20V1} from "./interfaces/IDopplerERC20V1.sol";
import {IFeeEscrow} from "./interfaces/IFeeEscrow.sol";
import {IBuybackVault} from "./interfaces/IBuybackVault.sol";
import {IPlatformFeeReceiver} from "./interfaces/IPlatformFeeReceiver.sol";
import {RevenueRouter} from "./RevenueRouter.sol";
import {FeeEscrow} from "./FeeEscrow.sol";
import {BuybackVault} from "./BuybackVault.sol";
import {PlatformFeeReceiver} from "./PlatformFeeReceiver.sol";

/// @title  AstralaunchRegistry
/// @notice Verifies a Doppler-launched asset matches the Astralaunch config, then deploys
///         a RevenueRouter clone and registers the asset in FeeEscrow and BuybackVault.
///
///         v2 changes from RevpadRegistry:
///         - Dual numeraire support: USDC or WMON pairs.
///         - Initializer allowlist with 48-hour timelock (Decision #5).
///         - Guardian role for cancel-only operations (Decision #4).
///         - Balance-limit exclusion checks at registration (Decision #6).
///         - Per-token numeraire storage, passed to all singletons.
///
///         Launch flow (SPEC S6.1 / D11):
///         1. Creator launches with Doppler SDK (fixed Astralaunch config).
///         2. Anyone calls register(asset, creator).
///         3. Registry reads on-chain state and reverts on any mismatch.
///         4. On success: clone deployed, escrow/vault notified, Registered emitted.
contract AstralaunchRegistry {
    // ── Verified Monad mainnet addresses (SPEC S23) ─────────────────────────
    IAirlock     constant AIRLOCK        = IAirlock(0x660eAaEdEBc968f8f3694354FA8EC0b4c5Ba8D12);
    address      constant NOMIG          = 0x5F3bA43D44375286296Cb85F1EA2EBfa25dde731;
    // NOGOV = 0x...dEaD: the dead address is the noOp governance instance stored by Airlock
    address      constant NOGOV          = 0x000000000000000000000000000000000000dEaD;
    address      constant USDC           = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address      constant WMON           = 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A;
    address      constant AIRLOCK_OWNER  = 0x21E2ce70511e4FE542a97708e89520471DAa7A66;
    // DOPPLER_HOOK is constant across all V4ScheduledMulticurveInitializer launches (D16).
    address      constant DOPPLER_HOOK   = 0x580ca49389d83b019d07E17e99454f2F218e2dc0;

    // ── Initializer allowlist timelock ───────────────────────────────────────
    uint256 constant INITIALIZER_DELAY = 48 hours;

    struct PendingInitializer {
        address initializer;
        address adapter;
        uint256 executableAt;
    }

    /// @notice Mapping of allowed initializer addresses to their enabled status.
    mapping(address initializer => bool) public allowedInitializers;

    /// @notice Mapping of initializer addresses to their fee adapter contracts.
    mapping(address initializer => IFeeAdapter) public feeAdapters;

    /// @notice The current pending initializer proposal (zero if none).
    PendingInitializer public pendingInitializer;

    // ── Mutable singletons ──────────────────────────────────────────────────
    IPlatformFeeReceiver public platformFeeReceiver;
    IFeeEscrow    public feeEscrow;
    IBuybackVault public buybackVault;
    address       public routerImplementation;
    address       public admin;
    bool          public paused;
    address       public pendingAdmin;

    /// @notice Immutable guardian address. Can only call cancel functions.
    address       public immutable guardian;

    // ── Registry state ──────────────────────────────────────────────────────
    mapping(address asset => address router) public routers;

    /// @notice Per-token numeraire (USDC or WMON).
    mapping(address asset => address numeraire) public assetNumeraires;

    /// @notice Per-token initializer address (which initializer was used to launch).
    mapping(address asset => address initializer) public assetInitializers;

    // ── Errors ──────────────────────────────────────────────────────────────
    error Paused();
    error AlreadyRegistered();
    error NotAdmin();
    error NotPendingAdmin();
    error NotGuardian();
    error NotAdminOrGuardian();
    error ZeroAddress();
    error NoActiveTransfer();

    // Initializer allowlist errors
    error InitializerNotAllowed(address initializer);
    error InitializerAlreadyAllowed(address initializer);
    error ProposalAlreadyActive();
    error NoActiveProposal();
    error ProposalNotReady();

    // Airlock / initializer mismatch errors
    error WrongInitializer(address got);
    error WrongMigrator(address got, address expected);
    error WrongGovernance(address got, address expected);
    error WrongNumeraire(address got);
    error WrongIntegrator(address got, address expected);

    // Pool config mismatch errors
    error WrongPool();  // hook address != DOPPLER_HOOK
    error WrongFee(uint24 got, uint24 expected);
    error WrongTickSpacing(int24 got, int24 expected);
    error WrongPoolCurrencies(); // pool must pair asset with its numeraire

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

    // Balance-limit exclusion errors (Decision #6)
    error NotExcludedFromBalanceLimit(address account);

    // ── Events ──────────────────────────────────────────────────────────────
    event Registered(
        address indexed asset,
        address indexed creator,
        address indexed router,
        bytes32 poolId,
        address numeraire,
        address initializer,
        uint256 timestamp
    );
    event PauseSet(bool paused);
    event AdminTransferStarted(address indexed currentAdmin, address indexed pendingAdmin);
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);
    event AdminTransferCancelled(address indexed cancelledPendingAdmin);

    // Initializer allowlist events
    event InitializerProposed(address indexed initializer, address indexed adapter, uint256 executableAt);
    event InitializerAccepted(address indexed initializer, address indexed adapter);
    event InitializerProposalCancelled(address indexed initializer);

    // ── Constructor ─────────────────────────────────────────────────────────
    /// @param _platformFeeReceiver  PlatformFeeReceiver singleton.
    /// @param _feeEscrow            FeeEscrow singleton.
    /// @param _buybackVault         BuybackVault singleton.
    /// @param _routerImpl           RevenueRouter implementation for EIP-1167 clones.
    /// @param _admin                Initial admin address.
    /// @param _guardian             Immutable guardian address (cancel-only role).
    /// @param _initialInitializer   The V4ScheduledMulticurveInitializer to allowlist at deploy.
    /// @param _initialAdapter       The IFeeAdapter for the initial initializer.
    constructor(
        address _platformFeeReceiver,
        address _feeEscrow,
        address _buybackVault,
        address _routerImpl,
        address _admin,
        address _guardian,
        address _initialInitializer,
        address _initialAdapter
    ) {
        if (_guardian == address(0)) revert ZeroAddress();

        platformFeeReceiver  = IPlatformFeeReceiver(_platformFeeReceiver);
        feeEscrow            = IFeeEscrow(_feeEscrow);
        buybackVault         = IBuybackVault(_buybackVault);
        routerImplementation = _routerImpl;
        admin                = _admin;
        guardian             = _guardian;

        // Seed the first allowed initializer (no delay for constructor)
        if (_initialInitializer != address(0)) {
            allowedInitializers[_initialInitializer] = true;
            feeAdapters[_initialInitializer] = IFeeAdapter(_initialAdapter);
            emit InitializerAccepted(_initialInitializer, _initialAdapter);
        }
    }

    // ── Register ────────────────────────────────────────────────────────────
    /// @notice Verify `asset`'s on-chain config and register it on Astralaunch.
    /// @param asset   The DopplerERC20V1 token address.
    /// @param creator The address that owns the 35% Doppler fee share and the 150M vesting.
    ///                Verified by checking getShares(poolId, creator) == CREATOR_SHARE_WAD
    ///                and totalAllocatedOf(creator) == VESTED_TOKENS_NUM.
    /// @return router Address of the newly deployed RevenueRouter clone.
    function register(address asset, address creator)
        external
        returns (address router)
    {
        if (paused) revert Paused();
        if (routers[asset] != address(0)) revert AlreadyRegistered();

        // ── 1. Airlock data ─────────────────────────────────────────────────
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

        // Initializer must be in the allowlist (Decision #5)
        if (!allowedInitializers[poolInitializer]) revert InitializerNotAllowed(poolInitializer);

        if (migrator   != NOMIG) revert WrongMigrator(migrator, NOMIG);
        if (governance != NOGOV) revert WrongGovernance(governance, NOGOV);

        // Dual numeraire: must be USDC or WMON
        if (numeraire != USDC && numeraire != WMON) revert WrongNumeraire(numeraire);

        if (totalSupply     != C.TOTAL_SUPPLY)    revert WrongTotalSupply(totalSupply, C.TOTAL_SUPPLY);
        if (numTokensToSell != C.POOL_TOKENS_NUM) revert WrongNumTokensToSell(numTokensToSell, C.POOL_TOKENS_NUM);
        if (integrator      != address(platformFeeReceiver)) revert WrongIntegrator(integrator, address(platformFeeReceiver));

        // ── 2. Pool key from getState via fee adapter ───────────────────────
        IFeeAdapter adapter = feeAdapters[poolInitializer];
        (, , PoolKey memory poolKey,) = adapter.getState(asset);

        if (poolKey.hooks       != DOPPLER_HOOK)   revert WrongPool();
        if (poolKey.fee         != C.POOL_FEE)     revert WrongFee(poolKey.fee, C.POOL_FEE);
        if (poolKey.tickSpacing != C.TICK_SPACING) revert WrongTickSpacing(poolKey.tickSpacing, C.TICK_SPACING);

        // Verify pool currencies are asset paired with the correct numeraire
        bool c0isNumeraire = poolKey.currency0 == numeraire && poolKey.currency1 == asset;
        bool c1isNumeraire = poolKey.currency1 == numeraire && poolKey.currency0 == asset;
        if (!c0isNumeraire && !c1isNumeraire) revert WrongPoolCurrencies();

        // Compute poolId on-chain from the verified poolKey
        bytes32 poolId = keccak256(abi.encode(poolKey));

        // ── 3. Beneficiary shares (checked via adapter) ─────────────────────
        _checkShare(adapter, poolId, AIRLOCK_OWNER,                C.DOPPLER_SHARE_WAD,  0);
        _checkShare(adapter, poolId, creator,                      C.CREATOR_SHARE_WAD,  1);
        _checkShare(adapter, poolId, address(feeEscrow),           C.ESCROW_SHARE_WAD,   2);
        _checkShare(adapter, poolId, address(buybackVault),        C.BUYBACK_SHARE_WAD,  3);
        _checkShare(adapter, poolId, address(platformFeeReceiver), C.TREASURY_SHARE_WAD, 4);

        // ── 4. Token vesting + balance cap ──────────────────────────────────
        IDopplerERC20V1 tok = IDopplerERC20V1(asset);
        (uint64 cliff, uint64 duration) = tok.vestingSchedules(0);
        if (cliff    != uint64(C.VESTING_CLIFF))    revert WrongVestingCliff(cliff, uint64(C.VESTING_CLIFF));
        if (duration != uint64(C.VESTING_DURATION)) revert WrongVestingDuration(duration, uint64(C.VESTING_DURATION));

        // Verify creator is the sole vesting beneficiary with exactly 150M tokens
        uint256 allocatedToCreator = tok.totalAllocatedOf(creator);
        if (allocatedToCreator != C.VESTED_TOKENS_NUM)
            revert WrongVestingAmount(allocatedToCreator, C.VESTED_TOKENS_NUM);
        uint256 totalVested = tok.vestedTotalAmount();
        if (totalVested != C.VESTED_TOKENS_NUM)
            revert WrongVestingAmount(totalVested, C.VESTED_TOKENS_NUM);

        // Balance cap: absolute value and window [BALANCE_CAP_WINDOW, BALANCE_CAP_WINDOW_MAX]
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

        // ── 4b. Balance-limit exclusions (Decision #6) ──────────────────────
        // FeeEscrow, BuybackVault, and PlatformFeeReceiver must be excluded
        // from the per-wallet balance limit so they can hold tokens during
        // the cap window without reverting.
        if (!tok.isExcludedFromBalanceLimit(address(feeEscrow)))
            revert NotExcludedFromBalanceLimit(address(feeEscrow));
        if (!tok.isExcludedFromBalanceLimit(address(buybackVault)))
            revert NotExcludedFromBalanceLimit(address(buybackVault));
        if (!tok.isExcludedFromBalanceLimit(address(platformFeeReceiver)))
            revert NotExcludedFromBalanceLimit(address(platformFeeReceiver));

        // ── 5. Deploy router clone ──────────────────────────────────────────
        router = LibClone.clone(routerImplementation);
        RevenueRouter(router).initialize(
            asset,
            creator,
            creator,       // provider defaults to creator
            address(this),
            address(feeEscrow),
            address(buybackVault),
            address(platformFeeReceiver)
        );

        // ── 6. Register in singletons (with numeraire + adapter) ────────
        uint48 launchTime = uint48(tok.vestingStart());
        feeEscrow.registerAsset(asset, creator, launchTime, poolId, numeraire);
        feeEscrow.authorizeRouter(router);
        FeeEscrow(address(feeEscrow)).setAdapter(asset, address(adapter));
        buybackVault.registerAsset(asset, poolKey, poolId, numeraire);
        buybackVault.authorize(router);
        buybackVault.authorize(address(feeEscrow));
        BuybackVault(payable(address(buybackVault))).setAdapter(asset, address(adapter));
        platformFeeReceiver.registerAsset(asset, poolId, numeraire);
        PlatformFeeReceiver(address(platformFeeReceiver)).setAdapter(asset, address(adapter));

        // ── 7. Store registry state ─────────────────────────────────────────
        routers[asset]          = router;
        assetNumeraires[asset]  = numeraire;
        assetInitializers[asset] = poolInitializer;

        emit Registered(asset, creator, router, poolId, numeraire, poolInitializer, block.timestamp);
    }

    // ── View ────────────────────────────────────────────────────────────────
    /// @notice Returns true if the asset has been registered.
    function isRegistered(address asset) external view returns (bool) {
        return routers[asset] != address(0);
    }

    /// @notice Returns the PlatformFeeReceiver address (used as treasury destination).
    function treasury() external view returns (address) {
        return address(platformFeeReceiver);
    }

    // ── Admin: pause ────────────────────────────────────────────────────────
    /// @notice Pause or unpause new registrations. Only admin.
    function setPause(bool _paused) external {
        if (msg.sender != admin) revert NotAdmin();
        paused = _paused;
        emit PauseSet(_paused);
    }

    // ── Admin: two-step admin transfer ──────────────────────────────────────
    /// @notice Start a two-step admin transfer. Only current admin.
    function transferAdmin(address newAdmin) external {
        if (msg.sender != admin) revert NotAdmin();
        if (newAdmin == address(0)) revert ZeroAddress();
        pendingAdmin = newAdmin;
        emit AdminTransferStarted(admin, newAdmin);
    }

    /// @notice Accept admin role. Only pendingAdmin.
    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotPendingAdmin();
        address oldAdmin = admin;
        admin = pendingAdmin;
        pendingAdmin = address(0);
        emit AdminTransferred(oldAdmin, admin);
    }

    /// @notice Cancel a pending admin transfer. Admin or guardian.
    function cancelAdminTransfer() external {
        if (msg.sender != admin && msg.sender != guardian) revert NotAdminOrGuardian();
        if (pendingAdmin == address(0)) revert NoActiveTransfer();
        address cancelled = pendingAdmin;
        pendingAdmin = address(0);
        emit AdminTransferCancelled(cancelled);
    }

    // ── Admin: initializer allowlist (Decision #5) ──────────────────────────
    /// @notice Propose adding a new initializer + adapter pair. 48-hour delay before acceptance.
    ///         Only admin.
    /// @param _initializer  The initializer contract address to allow.
    /// @param _adapter      The IFeeAdapter that wraps fee collection for this initializer.
    function proposeInitializer(address _initializer, address _adapter) external {
        if (msg.sender != admin) revert NotAdmin();
        if (_initializer == address(0) || _adapter == address(0)) revert ZeroAddress();
        if (allowedInitializers[_initializer]) revert InitializerAlreadyAllowed(_initializer);
        if (pendingInitializer.executableAt != 0) revert ProposalAlreadyActive();

        pendingInitializer = PendingInitializer({
            initializer:  _initializer,
            adapter:      _adapter,
            executableAt: block.timestamp + INITIALIZER_DELAY
        });

        emit InitializerProposed(_initializer, _adapter, pendingInitializer.executableAt);
    }

    /// @notice Accept the pending initializer proposal after the 48-hour delay. Only admin.
    function acceptInitializer() external {
        if (msg.sender != admin) revert NotAdmin();
        PendingInitializer memory p = pendingInitializer;
        if (p.executableAt == 0) revert NoActiveProposal();
        if (block.timestamp < p.executableAt) revert ProposalNotReady();

        allowedInitializers[p.initializer] = true;
        feeAdapters[p.initializer] = IFeeAdapter(p.adapter);

        // Clear proposal
        delete pendingInitializer;

        emit InitializerAccepted(p.initializer, p.adapter);
    }

    /// @notice Cancel a pending initializer proposal. Admin or guardian.
    function cancelInitializerProposal() external {
        if (msg.sender != admin && msg.sender != guardian) revert NotAdminOrGuardian();
        if (pendingInitializer.executableAt == 0) revert NoActiveProposal();

        address cancelled = pendingInitializer.initializer;
        delete pendingInitializer;

        emit InitializerProposalCancelled(cancelled);
    }

    // ── Internal ────────────────────────────────────────────────────────────
    /// @dev tag: 0=doppler, 1=creator, 2=escrow, 3=buyback, 4=treasury (used for revert selection)
    function _checkShare(
        IFeeAdapter adapter,
        bytes32 poolId,
        address beneficiary,
        uint256 expected,
        uint8 tag
    ) internal view {
        uint256 got = adapter.getShares(poolId, beneficiary);
        if (got == expected) return;
        if (tag == 0) revert WrongDopplerShare(got, expected);
        if (tag == 1) revert WrongCreatorShare(got, expected);
        if (tag == 2) revert WrongEscrowShare(got, expected);
        if (tag == 3) revert WrongBuybackShare(got, expected);
        revert WrongTreasuryShare(got, expected);
    }
}

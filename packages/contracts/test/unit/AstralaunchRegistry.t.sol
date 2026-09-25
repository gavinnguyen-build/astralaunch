// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AstralaunchRegistry} from "../../src/AstralaunchRegistry.sol";
import {RevenueRouter} from "../../src/RevenueRouter.sol";
import {FeeEscrow} from "../../src/FeeEscrow.sol";
import {BuybackVault} from "../../src/BuybackVault.sol";
import {PlatformFeeReceiver} from "../../src/PlatformFeeReceiver.sol";
import {AstralaunchConstants as C} from "../../src/AstralaunchConstants.sol";
import {PoolKey} from "../../src/interfaces/IInitializer.sol";
import {IFeeAdapter} from "../../src/interfaces/IFeeAdapter.sol";

// ── Stubs ──────────────────────────────────────────────────────────────────────

contract MockAirlock {
    struct AssetConfig {
        address numeraire;
        address timelock;
        address governance;
        address migrator;
        address poolInitializer;
        address pool;
        address migrationPool;
        uint256 numTokensToSell;
        uint256 totalSupply;
        address integrator;
    }
    mapping(address => AssetConfig) public configs;

    function setConfig(address asset, AssetConfig calldata cfg) external {
        configs[asset] = cfg;
    }

    function getAssetData(address asset)
        external view
        returns (
            address numeraire, address timelock, address governance, address migrator,
            address poolInitializer, address pool, address migrationPool,
            uint256 numTokensToSell, uint256 totalSupply, address integrator
        )
    {
        AssetConfig memory c = configs[asset];
        return (c.numeraire, c.timelock, c.governance, c.migrator,
                c.poolInitializer, c.pool, c.migrationPool,
                c.numTokensToSell, c.totalSupply, c.integrator);
    }
}

/// @dev Implements IFeeAdapter so it can serve as both the "initializer" and the "fee adapter" in tests.
contract MockInitializerReg is IFeeAdapter {
    mapping(address => PoolKey)  public assetKeys_;      // asset -> poolKey (for getState)
    mapping(bytes32 => PoolKey)  public poolKeys_;       // poolId -> poolKey (legacy, kept)
    mapping(bytes32 => mapping(address => uint256)) public shares_;

    function setAssetKey(address asset, PoolKey calldata key) external {
        assetKeys_[asset] = key;
    }

    function setPoolKey(bytes32 poolId, PoolKey calldata key) external {
        poolKeys_[poolId] = key;
    }

    function setShare(bytes32 poolId, address who, uint256 wad) external {
        shares_[poolId][who] = wad;
    }

    /// @dev IFeeAdapter.getState: registry uses getState(asset) to retrieve the poolKey.
    function getState(address asset)
        external view override
        returns (address numeraire, uint8 status, PoolKey memory poolKey, int24 farTick)
    {
        return (address(0), 0, assetKeys_[asset], 0);
    }

    function getPoolKey(bytes32 poolId) external view returns (PoolKey memory) {
        return poolKeys_[poolId];
    }

    /// @dev IFeeAdapter.getShares
    function getShares(bytes32 poolId, address who) external view override returns (uint256) {
        return shares_[poolId][who];
    }

    /// @dev No-op fee collection for tests.
    function doCollect(bytes32) external pure returns (uint128, uint128) { return (0, 0); }

    /// @dev IFeeAdapter.collectFeesCall
    function collectFeesCall(bytes32 poolId)
        external view override
        returns (address target, bytes memory data)
    {
        return (address(this), abi.encodeCall(this.doCollect, (poolId)));
    }
}

contract MockToken {
    uint256 public vestingStart_;
    uint256 public maxBalanceLimit_;
    uint64  public cliff_;
    uint64  public duration_;
    uint48  public balanceLimitEnd_;
    uint256 public totalAllocated_;

    // Balance-limit exclusions (Decision #6)
    mapping(address => bool) public isExcludedFromBalanceLimit;

    function setup(uint64 cliff, uint64 duration, uint256 mbl, uint256 vs) external {
        cliff_           = cliff;
        duration_        = duration;
        maxBalanceLimit_ = mbl;
        vestingStart_    = vs;
    }

    function setBalanceLimitEnd(uint48 ble) external { balanceLimitEnd_ = ble; }
    function setTotalAllocated(uint256 a)   external { totalAllocated_  = a; }
    function setExcluded(address account, bool excluded) external { isExcludedFromBalanceLimit[account] = excluded; }

    function vestingSchedules(uint256) external view returns (uint64 cliff, uint64 duration) {
        return (cliff_, duration_);
    }
    function maxBalanceLimit()   external view returns (uint256) { return maxBalanceLimit_; }
    function vestingStart()      external view returns (uint256) { return vestingStart_; }
    function balanceLimitEnd()   external view returns (uint48)  { return balanceLimitEnd_; }
    function totalAllocatedOf(address) external view returns (uint256) { return totalAllocated_; }
    function vestedTotalAmount()       external view returns (uint256) { return totalAllocated_; }
    function vestingScheduleCount()    external view returns (uint256) { return 1; }

    function burn(uint256) external {}
    function balanceOf(address) external pure returns (uint256) { return 0; }
    function transfer(address, uint256) external pure returns (bool) { return true; }
}

contract MockUSDCReg {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }
    function transfer(address to, uint256 amt) external returns (bool) {
        require(balanceOf[msg.sender] >= amt);
        balanceOf[msg.sender] -= amt;
        balanceOf[to]         += amt;
        return true;
    }
}

contract MockPoolManagerReg {
    function unlock(bytes calldata) external pure returns (bytes memory) { return ""; }
    function settle() external payable returns (uint256) { return 0; }
    function sync(address) external {}
    function take(address, address, uint256) external {}
}

contract MockOracleReg {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, 2500000, 0, block.timestamp, 1);
    }
    function decimals() external pure returns (uint8) { return 8; }
}

// ── Test contract ──────────────────────────────────────────────────────────────
contract AstralaunchRegistryTest is Test {
    // canonical Monad mainnet addresses (from AstralaunchRegistry)
    address constant AIRLOCK_ADDR     = 0x660eAaEdEBc968f8f3694354FA8EC0b4c5Ba8D12;
    address constant INITIALIZER_ADDR = 0xCe3099B2F07029b086E5e92a1573C5f5A3071783;
    address constant NOMIG            = 0x5F3bA43D44375286296Cb85F1EA2EBfa25dde731;
    address constant NOGOV            = 0x000000000000000000000000000000000000dEaD;
    address constant USDC_ADDR        = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address constant WMON_ADDR        = 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A;
    address constant AIRLOCK_OWNER    = 0x21E2ce70511e4FE542a97708e89520471DAa7A66;
    address constant DOPPLER_HOOK     = 0x580ca49389d83b019d07E17e99454f2F218e2dc0;

    AstralaunchRegistry registry;
    MockAirlock         airlock;
    MockInitializerReg  init_;
    MockPoolManagerReg  pm;
    MockToken           token;

    RevenueRouter       routerImpl;
    FeeEscrow           escrow;
    BuybackVault        vault;
    PlatformFeeReceiver pfr;

    address admin    = address(0xAD);
    address guardian = address(0x6A12D);
    address treasury = address(0x7AEA5);
    address creator  = address(0xC8EA7012);

    address asset;
    bytes32 poolId;
    PoolKey poolKey;

    function setUp() public {
        // ── Pre-compute registry address ──────────────────────────────────────
        // Deployments before registry:
        //   +0 token, +1 tmpUsdc, +2 tmpWmon, +3 tmpAirlock, +4 tmpInit, +5 pm,
        //   +6 orc, +7 escrow, +8 vault, +9 pfr, +10 routerImpl => +11 = registry
        uint256 startNonce = vm.getNonce(address(this));
        address futureRegistry = vm.computeCreateAddress(address(this), startNonce + 11);

        token = new MockToken();  // +0

        {
            MockUSDCReg tmpUsdc = new MockUSDCReg();  // +1
            vm.etch(USDC_ADDR, address(tmpUsdc).code);
        }

        {
            // Etch a mock for WMON as well (minimal ERC20)
            MockUSDCReg tmpWmon = new MockUSDCReg();  // +2
            vm.etch(WMON_ADDR, address(tmpWmon).code);
        }

        {
            MockAirlock tmpAirlock = new MockAirlock();  // +3
            vm.etch(AIRLOCK_ADDR, address(tmpAirlock).code);
        }
        airlock = MockAirlock(AIRLOCK_ADDR);

        {
            MockInitializerReg tmpInit = new MockInitializerReg();  // +4
            vm.etch(INITIALIZER_ADDR, address(tmpInit).code);
        }
        init_ = MockInitializerReg(INITIALIZER_ADDR);

        pm         = new MockPoolManagerReg();  // +5
        MockOracleReg orc = new MockOracleReg(); // +6
        escrow     = new FeeEscrow(futureRegistry, address(0), address(orc), 3600);  // +7
        PoolKey memory monKey = PoolKey(address(0), USDC_ADDR, 500, 10, address(0));
        vault      = new BuybackVault(futureRegistry, address(pm), guardian, monKey);  // +8
        pfr        = new PlatformFeeReceiver(futureRegistry, treasury, admin, guardian); // +9
        routerImpl = new RevenueRouter();  // +10
        registry   = new AstralaunchRegistry(  // +11
            address(pfr), address(escrow), address(vault), address(routerImpl),
            admin, guardian, INITIALIZER_ADDR, address(init_)
        );
        require(address(registry) == futureRegistry, "nonce offset wrong");

        asset = address(token);

        // poolKey.hooks must be DOPPLER_HOOK for the happy path.
        poolKey = PoolKey({
            currency0:   USDC_ADDR < asset ? USDC_ADDR : asset,
            currency1:   USDC_ADDR < asset ? asset : USDC_ADDR,
            fee:         C.POOL_FEE,
            tickSpacing: C.TICK_SPACING,
            hooks:       DOPPLER_HOOK
        });
        poolId = keccak256(abi.encode(poolKey));

        // Configure token
        token.setup(uint64(C.VESTING_CLIFF), uint64(C.VESTING_DURATION), C.BALANCE_CAP_NUM, block.timestamp);
        token.setBalanceLimitEnd(uint48(block.timestamp + C.BALANCE_CAP_WINDOW + 1));
        token.setTotalAllocated(C.VESTED_TOKENS_NUM);

        // Set balance-limit exclusions (Decision #6)
        token.setExcluded(address(escrow), true);
        token.setExcluded(address(vault), true);
        token.setExcluded(address(pfr), true);

        // Configure airlock at canonical address (integrator must equal PFR address)
        airlock.setConfig(asset, _goodAirlockCfg());

        // Configure initializer at canonical address
        init_.setAssetKey(asset, poolKey);
        init_.setShare(poolId, AIRLOCK_OWNER,    C.DOPPLER_SHARE_WAD);
        init_.setShare(poolId, creator,          C.CREATOR_SHARE_WAD);
        init_.setShare(poolId, address(escrow),  C.ESCROW_SHARE_WAD);
        init_.setShare(poolId, address(vault),   C.BUYBACK_SHARE_WAD);
        init_.setShare(poolId, address(pfr),     C.TREASURY_SHARE_WAD);
    }

    // ── register: happy path ──────────────────────────────────────────────────
    function test_register_success() public {
        address router = registry.register(asset, creator);
        assertTrue(router != address(0));
        assertEq(registry.routers(asset), router);
        assertTrue(registry.isRegistered(asset));

        RevenueRouter rr = RevenueRouter(router);
        assertEq(rr.asset(),        asset);
        assertEq(rr.creator(),      creator);
        assertEq(rr.registry(),     address(registry));
        assertEq(rr.feeEscrow(),    address(escrow));
        assertEq(rr.buybackVault(), address(vault));
        assertEq(rr.treasury(),     address(pfr));
    }

    function test_register_emitsEvent() public {
        vm.expectEmit(true, true, false, false);
        emit AstralaunchRegistry.Registered(asset, creator, address(0), poolId, USDC_ADDR, INITIALIZER_ADDR, 0);
        registry.register(asset, creator);
    }

    function test_register_storesNumeraire() public {
        registry.register(asset, creator);
        assertEq(registry.assetNumeraires(asset), USDC_ADDR);
    }

    function test_register_storesInitializer() public {
        registry.register(asset, creator);
        assertEq(registry.assetInitializers(asset), INITIALIZER_ADDR);
    }

    function test_register_revertsIfDuplicate() public {
        registry.register(asset, creator);
        vm.expectRevert(AstralaunchRegistry.AlreadyRegistered.selector);
        registry.register(asset, creator);
    }

    function test_register_revertsWhenPaused() public {
        vm.prank(admin);
        registry.setPause(true);
        vm.expectRevert(AstralaunchRegistry.Paused.selector);
        registry.register(asset, creator);
    }

    // ── register: WMON numeraire happy path ───────────────────────────────────
    function test_register_wmonPairing_success() public {
        // Create a separate token for WMON pairing
        MockToken wmonToken = new MockToken();
        address wmonAsset = address(wmonToken);

        wmonToken.setup(uint64(C.VESTING_CLIFF), uint64(C.VESTING_DURATION), C.BALANCE_CAP_NUM, block.timestamp);
        wmonToken.setBalanceLimitEnd(uint48(block.timestamp + C.BALANCE_CAP_WINDOW + 1));
        wmonToken.setTotalAllocated(C.VESTED_TOKENS_NUM);
        wmonToken.setExcluded(address(escrow), true);
        wmonToken.setExcluded(address(vault), true);
        wmonToken.setExcluded(address(pfr), true);

        PoolKey memory wmonPoolKey = PoolKey({
            currency0:   WMON_ADDR < wmonAsset ? WMON_ADDR : wmonAsset,
            currency1:   WMON_ADDR < wmonAsset ? wmonAsset : WMON_ADDR,
            fee:         C.POOL_FEE,
            tickSpacing: C.TICK_SPACING,
            hooks:       DOPPLER_HOOK
        });
        bytes32 wmonPoolId = keccak256(abi.encode(wmonPoolKey));

        // Config airlock with WMON numeraire
        MockAirlock.AssetConfig memory cfg = MockAirlock.AssetConfig({
            numeraire:       WMON_ADDR,
            timelock:        address(0),
            governance:      NOGOV,
            migrator:        NOMIG,
            poolInitializer: INITIALIZER_ADDR,
            pool:            address(0),
            migrationPool:   address(0),
            numTokensToSell: C.POOL_TOKENS_NUM,
            totalSupply:     C.TOTAL_SUPPLY,
            integrator:      address(pfr)
        });
        airlock.setConfig(wmonAsset, cfg);

        init_.setAssetKey(wmonAsset, wmonPoolKey);
        init_.setShare(wmonPoolId, AIRLOCK_OWNER,    C.DOPPLER_SHARE_WAD);
        init_.setShare(wmonPoolId, creator,          C.CREATOR_SHARE_WAD);
        init_.setShare(wmonPoolId, address(escrow),  C.ESCROW_SHARE_WAD);
        init_.setShare(wmonPoolId, address(vault),   C.BUYBACK_SHARE_WAD);
        init_.setShare(wmonPoolId, address(pfr),     C.TREASURY_SHARE_WAD);

        address router = registry.register(wmonAsset, creator);
        assertTrue(router != address(0));
        assertEq(registry.assetNumeraires(wmonAsset), WMON_ADDR);
    }

    // ── register: airlock mismatch errors ─────────────────────────────────────
    function test_register_revertsWrongNumeraire() public {
        MockAirlock.AssetConfig memory cfg = _goodAirlockCfg();
        cfg.numeraire = address(0x1234); // not USDC or WMON
        airlock.setConfig(asset, cfg);
        vm.expectRevert(abi.encodeWithSelector(AstralaunchRegistry.WrongNumeraire.selector, address(0x1234)));
        registry.register(asset, creator);
    }

    function test_register_revertsInitializerNotAllowed() public {
        MockAirlock.AssetConfig memory cfg = _goodAirlockCfg();
        cfg.poolInitializer = address(0xBAD);
        airlock.setConfig(asset, cfg);
        vm.expectRevert(abi.encodeWithSelector(AstralaunchRegistry.InitializerNotAllowed.selector, address(0xBAD)));
        registry.register(asset, creator);
    }

    function test_register_revertsWrongMigrator() public {
        MockAirlock.AssetConfig memory cfg = _goodAirlockCfg();
        cfg.migrator = address(0xBAD);
        airlock.setConfig(asset, cfg);
        vm.expectRevert(abi.encodeWithSelector(AstralaunchRegistry.WrongMigrator.selector, address(0xBAD), NOMIG));
        registry.register(asset, creator);
    }

    function test_register_revertsWrongGovernance() public {
        MockAirlock.AssetConfig memory cfg = _goodAirlockCfg();
        cfg.governance = address(0xBAD);
        airlock.setConfig(asset, cfg);
        vm.expectRevert(abi.encodeWithSelector(AstralaunchRegistry.WrongGovernance.selector, address(0xBAD), NOGOV));
        registry.register(asset, creator);
    }

    function test_register_revertsWrongTotalSupply() public {
        MockAirlock.AssetConfig memory cfg = _goodAirlockCfg();
        cfg.totalSupply = C.TOTAL_SUPPLY + 1;
        airlock.setConfig(asset, cfg);
        vm.expectRevert(abi.encodeWithSelector(AstralaunchRegistry.WrongTotalSupply.selector, C.TOTAL_SUPPLY + 1, C.TOTAL_SUPPLY));
        registry.register(asset, creator);
    }

    function test_register_revertsWrongNumTokensToSell() public {
        MockAirlock.AssetConfig memory cfg = _goodAirlockCfg();
        cfg.numTokensToSell = C.POOL_TOKENS_NUM + 1;
        airlock.setConfig(asset, cfg);
        vm.expectRevert(abi.encodeWithSelector(AstralaunchRegistry.WrongNumTokensToSell.selector, C.POOL_TOKENS_NUM + 1, C.POOL_TOKENS_NUM));
        registry.register(asset, creator);
    }

    function test_register_revertsWrongIntegrator() public {
        MockAirlock.AssetConfig memory cfg = _goodAirlockCfg();
        cfg.integrator = address(0xBAD);
        airlock.setConfig(asset, cfg);
        vm.expectRevert(abi.encodeWithSelector(AstralaunchRegistry.WrongIntegrator.selector, address(0xBAD), address(pfr)));
        registry.register(asset, creator);
    }

    // ── register: pool key errors ─────────────────────────────────────────────

    function test_register_revertsWrongPool() public {
        PoolKey memory bad = poolKey;
        bad.hooks = address(0xBAD);
        init_.setAssetKey(asset, bad);
        vm.expectRevert(AstralaunchRegistry.WrongPool.selector);
        registry.register(asset, creator);
    }

    function test_register_revertsWrongFee() public {
        PoolKey memory bad = poolKey;
        bad.fee = 3000;
        init_.setAssetKey(asset, bad);
        vm.expectRevert(abi.encodeWithSelector(AstralaunchRegistry.WrongFee.selector, uint24(3000), C.POOL_FEE));
        registry.register(asset, creator);
    }

    function test_register_revertsWrongTickSpacing() public {
        PoolKey memory bad = poolKey;
        bad.tickSpacing = 60;
        init_.setAssetKey(asset, bad);
        vm.expectRevert(abi.encodeWithSelector(AstralaunchRegistry.WrongTickSpacing.selector, int24(60), C.TICK_SPACING));
        registry.register(asset, creator);
    }

    function test_register_revertsWrongPoolCurrencies() public {
        PoolKey memory bad = PoolKey({
            currency0:   address(0x1111),
            currency1:   USDC_ADDR,
            fee:         C.POOL_FEE,
            tickSpacing: C.TICK_SPACING,
            hooks:       DOPPLER_HOOK
        });
        init_.setAssetKey(asset, bad);
        vm.expectRevert(AstralaunchRegistry.WrongPoolCurrencies.selector);
        registry.register(asset, creator);
    }

    // ── register: beneficiary share errors ───────────────────────────────────
    function test_register_revertsWrongDopplerShare() public {
        init_.setShare(poolId, AIRLOCK_OWNER, C.DOPPLER_SHARE_WAD + 1);
        vm.expectRevert(abi.encodeWithSelector(AstralaunchRegistry.WrongDopplerShare.selector, C.DOPPLER_SHARE_WAD + 1, C.DOPPLER_SHARE_WAD));
        registry.register(asset, creator);
    }

    function test_register_revertsWrongCreatorShare() public {
        init_.setShare(poolId, creator, C.CREATOR_SHARE_WAD + 1);
        vm.expectRevert(abi.encodeWithSelector(AstralaunchRegistry.WrongCreatorShare.selector, C.CREATOR_SHARE_WAD + 1, C.CREATOR_SHARE_WAD));
        registry.register(asset, creator);
    }

    function test_register_revertsWrongEscrowShare() public {
        init_.setShare(poolId, address(escrow), C.ESCROW_SHARE_WAD + 1);
        vm.expectRevert(abi.encodeWithSelector(AstralaunchRegistry.WrongEscrowShare.selector, C.ESCROW_SHARE_WAD + 1, C.ESCROW_SHARE_WAD));
        registry.register(asset, creator);
    }

    function test_register_revertsWrongBuybackShare() public {
        init_.setShare(poolId, address(vault), C.BUYBACK_SHARE_WAD + 1);
        vm.expectRevert(abi.encodeWithSelector(AstralaunchRegistry.WrongBuybackShare.selector, C.BUYBACK_SHARE_WAD + 1, C.BUYBACK_SHARE_WAD));
        registry.register(asset, creator);
    }

    function test_register_revertsWrongTreasuryShare() public {
        init_.setShare(poolId, address(pfr), C.TREASURY_SHARE_WAD + 1);
        vm.expectRevert(abi.encodeWithSelector(AstralaunchRegistry.WrongTreasuryShare.selector, C.TREASURY_SHARE_WAD + 1, C.TREASURY_SHARE_WAD));
        registry.register(asset, creator);
    }

    // ── register: token vesting / balance cap errors ──────────────────────────
    function test_register_revertsWrongVestingCliff() public {
        token.setup(uint64(C.VESTING_CLIFF) + 1, uint64(C.VESTING_DURATION), C.BALANCE_CAP_NUM, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(AstralaunchRegistry.WrongVestingCliff.selector, uint64(C.VESTING_CLIFF) + 1, uint64(C.VESTING_CLIFF)));
        registry.register(asset, creator);
    }

    function test_register_revertsWrongVestingDuration() public {
        token.setup(uint64(C.VESTING_CLIFF), uint64(C.VESTING_DURATION) + 1, C.BALANCE_CAP_NUM, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(AstralaunchRegistry.WrongVestingDuration.selector, uint64(C.VESTING_DURATION) + 1, uint64(C.VESTING_DURATION)));
        registry.register(asset, creator);
    }

    function test_register_revertsWrongVestingAmount() public {
        uint256 badAmount = 50_000_000 * 1e18;
        token.setTotalAllocated(badAmount);
        vm.expectRevert(abi.encodeWithSelector(AstralaunchRegistry.WrongVestingAmount.selector, badAmount, C.VESTED_TOKENS_NUM));
        registry.register(asset, creator);
    }

    function test_register_revertsWrongBalanceCap() public {
        token.setup(uint64(C.VESTING_CLIFF), uint64(C.VESTING_DURATION), C.BALANCE_CAP_NUM + 1, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(AstralaunchRegistry.WrongBalanceCap.selector, C.BALANCE_CAP_NUM + 1, C.BALANCE_CAP_NUM));
        registry.register(asset, creator);
    }

    function test_register_revertsWrongBalanceCap_window() public {
        token.setBalanceLimitEnd(uint48(block.timestamp)); // window = 0 s < 600 s
        vm.expectRevert(abi.encodeWithSelector(AstralaunchRegistry.WrongBalanceCap.selector, uint256(0), C.BALANCE_CAP_WINDOW));
        registry.register(asset, creator);
    }

    function test_register_revertsWrongBalanceCap_windowTooWide() public {
        uint256 tooWide = C.BALANCE_CAP_WINDOW_MAX + 1;
        token.setBalanceLimitEnd(uint48(block.timestamp + tooWide));
        vm.expectRevert(abi.encodeWithSelector(AstralaunchRegistry.WrongBalanceCap.selector, tooWide, C.BALANCE_CAP_WINDOW_MAX));
        registry.register(asset, creator);
    }

    function test_register_revertsWrongBalanceCap_window599() public {
        token.setBalanceLimitEnd(uint48(block.timestamp + 599));
        vm.expectRevert(abi.encodeWithSelector(AstralaunchRegistry.WrongBalanceCap.selector, uint256(599), C.BALANCE_CAP_WINDOW));
        registry.register(asset, creator);
    }

    function test_register_acceptsWindow600() public {
        token.setBalanceLimitEnd(uint48(block.timestamp + 600));
        address router = registry.register(asset, creator);
        assertTrue(router != address(0));
    }

    function test_register_acceptsWindow900() public {
        token.setBalanceLimitEnd(uint48(block.timestamp + 900));
        address router = registry.register(asset, creator);
        assertTrue(router != address(0));
    }

    function test_register_revertsWrongBalanceCap_window901() public {
        token.setBalanceLimitEnd(uint48(block.timestamp + 901));
        vm.expectRevert(abi.encodeWithSelector(AstralaunchRegistry.WrongBalanceCap.selector, uint256(901), C.BALANCE_CAP_WINDOW_MAX));
        registry.register(asset, creator);
    }

    // ── register: balance-limit exclusion errors (Decision #6) ────────────────
    function test_register_revertsNotExcluded_escrow() public {
        token.setExcluded(address(escrow), false);
        vm.expectRevert(abi.encodeWithSelector(AstralaunchRegistry.NotExcludedFromBalanceLimit.selector, address(escrow)));
        registry.register(asset, creator);
    }

    function test_register_revertsNotExcluded_vault() public {
        token.setExcluded(address(vault), false);
        vm.expectRevert(abi.encodeWithSelector(AstralaunchRegistry.NotExcludedFromBalanceLimit.selector, address(vault)));
        registry.register(asset, creator);
    }

    function test_register_revertsNotExcluded_pfr() public {
        token.setExcluded(address(pfr), false);
        vm.expectRevert(abi.encodeWithSelector(AstralaunchRegistry.NotExcludedFromBalanceLimit.selector, address(pfr)));
        registry.register(asset, creator);
    }

    // ── treasury getter ───────────────────────────────────────────────────────
    function test_treasury_returnsPFRAddress() public view {
        assertEq(registry.treasury(), address(pfr));
    }

    // ── PlatformFeeReceiver wiring ────────────────────────────────────────────
    function test_register_registersPFRAsset() public {
        registry.register(asset, creator);
        assertEq(pfr.assetPoolIds(asset), poolId);
    }

    // ── admin: pause ─────────────────────────────────────────────────────
    function test_setPause_byAdmin() public {
        vm.prank(admin);
        registry.setPause(true);
        assertTrue(registry.paused());
        vm.prank(admin);
        registry.setPause(false);
        assertFalse(registry.paused());
    }

    function test_setPause_revertsIfNotAdmin() public {
        vm.expectRevert(AstralaunchRegistry.NotAdmin.selector);
        registry.setPause(true);
    }

    // ── admin transfer ──────────────────────────────────────────────────────

    function test_transferAdmin_setsPendingAdmin() public {
        address newAdmin = address(0xCAFE);
        vm.prank(admin);
        registry.transferAdmin(newAdmin);
        assertEq(registry.pendingAdmin(), newAdmin);
    }

    function test_transferAdmin_emitsEvent() public {
        address newAdmin = address(0xCAFE);
        vm.prank(admin);
        vm.expectEmit(true, true, false, false);
        emit AstralaunchRegistry.AdminTransferStarted(admin, newAdmin);
        registry.transferAdmin(newAdmin);
    }

    function test_transferAdmin_revertsIfNotAdmin() public {
        vm.expectRevert(AstralaunchRegistry.NotAdmin.selector);
        registry.transferAdmin(address(0xCAFE));
    }

    function test_transferAdmin_revertsZeroAddress() public {
        vm.prank(admin);
        vm.expectRevert(AstralaunchRegistry.ZeroAddress.selector);
        registry.transferAdmin(address(0));
    }

    function test_acceptAdmin_updatesAdmin() public {
        address newAdmin = address(0xCAFE);
        vm.prank(admin);
        registry.transferAdmin(newAdmin);

        vm.prank(newAdmin);
        registry.acceptAdmin();
        assertEq(registry.admin(), newAdmin);
        assertEq(registry.pendingAdmin(), address(0));
    }

    function test_acceptAdmin_emitsEvent() public {
        address newAdmin = address(0xCAFE);
        vm.prank(admin);
        registry.transferAdmin(newAdmin);

        vm.prank(newAdmin);
        vm.expectEmit(true, true, false, false);
        emit AstralaunchRegistry.AdminTransferred(admin, newAdmin);
        registry.acceptAdmin();
    }

    function test_acceptAdmin_revertsIfNotPendingAdmin() public {
        vm.prank(admin);
        registry.transferAdmin(address(0xCAFE));

        vm.prank(admin); // not pendingAdmin
        vm.expectRevert(AstralaunchRegistry.NotPendingAdmin.selector);
        registry.acceptAdmin();
    }

    function test_acceptAdmin_revertsIfNoPending() public {
        vm.expectRevert(AstralaunchRegistry.NotPendingAdmin.selector);
        registry.acceptAdmin();
    }

    // ── cancelAdminTransfer: admin or guardian can cancel ──────────────────
    function test_cancelAdminTransfer_byAdmin_clearsState() public {
        vm.prank(admin);
        registry.transferAdmin(address(0xCAFE));

        vm.prank(admin);
        registry.cancelAdminTransfer();
        assertEq(registry.pendingAdmin(), address(0));
    }

    function test_cancelAdminTransfer_byGuardian_clearsState() public {
        vm.prank(admin);
        registry.transferAdmin(address(0xCAFE));

        vm.prank(guardian);
        registry.cancelAdminTransfer();
        assertEq(registry.pendingAdmin(), address(0));
    }

    function test_cancelAdminTransfer_emitsEvent() public {
        address newAdmin = address(0xCAFE);
        vm.prank(admin);
        registry.transferAdmin(newAdmin);

        vm.prank(admin);
        vm.expectEmit(true, false, false, false);
        emit AstralaunchRegistry.AdminTransferCancelled(newAdmin);
        registry.cancelAdminTransfer();
    }

    function test_cancelAdminTransfer_revertsIfNoTransfer() public {
        vm.prank(admin);
        vm.expectRevert(AstralaunchRegistry.NoActiveTransfer.selector);
        registry.cancelAdminTransfer();
    }

    function test_cancelAdminTransfer_revertsIfNotAdminOrGuardian() public {
        vm.prank(admin);
        registry.transferAdmin(address(0xCAFE));

        vm.expectRevert(AstralaunchRegistry.NotAdminOrGuardian.selector);
        registry.cancelAdminTransfer();
    }

    function test_oldAdminLosesAllRights() public {
        address newAdmin = address(0xCAFE);
        vm.prank(admin);
        registry.transferAdmin(newAdmin);
        vm.prank(newAdmin);
        registry.acceptAdmin();

        // Old admin cannot pause
        vm.prank(admin);
        vm.expectRevert(AstralaunchRegistry.NotAdmin.selector);
        registry.setPause(true);

        // Old admin cannot transfer again
        vm.prank(admin);
        vm.expectRevert(AstralaunchRegistry.NotAdmin.selector);
        registry.transferAdmin(address(0xDEAD));

        // New admin CAN pause
        vm.prank(newAdmin);
        registry.setPause(true);
        assertTrue(registry.paused());
    }

    // ── guardian: cannot propose or accept (cancel only) ─────────────────────
    function test_guardian_cannotPause() public {
        vm.prank(guardian);
        vm.expectRevert(AstralaunchRegistry.NotAdmin.selector);
        registry.setPause(true);
    }

    function test_guardian_cannotTransferAdmin() public {
        vm.prank(guardian);
        vm.expectRevert(AstralaunchRegistry.NotAdmin.selector);
        registry.transferAdmin(address(0xCAFE));
    }

    function test_guardian_cannotAcceptAdmin() public {
        vm.prank(admin);
        registry.transferAdmin(address(0xCAFE));

        vm.prank(guardian);
        vm.expectRevert(AstralaunchRegistry.NotPendingAdmin.selector);
        registry.acceptAdmin();
    }

    // ── initializer allowlist timelock ─────────────────────────────────────────

    function test_proposeInitializer_setsProposal() public {
        address newInit = address(0xABCD);
        address newAdapter = address(0xEF01);

        vm.prank(admin);
        registry.proposeInitializer(newInit, newAdapter);

        (address proposedInit, address proposedAdapter, uint256 execAt) = registry.pendingInitializer();
        assertEq(proposedInit, newInit);
        assertEq(proposedAdapter, newAdapter);
        assertEq(execAt, block.timestamp + 48 hours);
    }

    function test_proposeInitializer_emitsEvent() public {
        address newInit = address(0xABCD);
        address newAdapter = address(0xEF01);

        vm.prank(admin);
        vm.expectEmit(true, true, false, true);
        emit AstralaunchRegistry.InitializerProposed(newInit, newAdapter, block.timestamp + 48 hours);
        registry.proposeInitializer(newInit, newAdapter);
    }

    function test_proposeInitializer_revertsIfNotAdmin() public {
        vm.expectRevert(AstralaunchRegistry.NotAdmin.selector);
        registry.proposeInitializer(address(0xABCD), address(0xEF01));
    }

    function test_proposeInitializer_revertsZeroInitializer() public {
        vm.prank(admin);
        vm.expectRevert(AstralaunchRegistry.ZeroAddress.selector);
        registry.proposeInitializer(address(0), address(0xEF01));
    }

    function test_proposeInitializer_revertsZeroAdapter() public {
        vm.prank(admin);
        vm.expectRevert(AstralaunchRegistry.ZeroAddress.selector);
        registry.proposeInitializer(address(0xABCD), address(0));
    }

    function test_proposeInitializer_revertsIfAlreadyAllowed() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(AstralaunchRegistry.InitializerAlreadyAllowed.selector, INITIALIZER_ADDR));
        registry.proposeInitializer(INITIALIZER_ADDR, address(0xEF01));
    }

    function test_proposeInitializer_revertsIfProposalActive() public {
        vm.prank(admin);
        registry.proposeInitializer(address(0xABCD), address(0xEF01));

        vm.prank(admin);
        vm.expectRevert(AstralaunchRegistry.ProposalAlreadyActive.selector);
        registry.proposeInitializer(address(0x1234), address(0x5678));
    }

    function test_acceptInitializer_afterDelay() public {
        address newInit = address(0xABCD);
        address newAdapter = address(0xEF01);

        vm.prank(admin);
        registry.proposeInitializer(newInit, newAdapter);

        // Warp past 48h delay
        vm.warp(block.timestamp + 48 hours);

        vm.prank(admin);
        registry.acceptInitializer();

        assertTrue(registry.allowedInitializers(newInit));
        // Verify the proposal is cleared
        (,, uint256 execAt) = registry.pendingInitializer();
        assertEq(execAt, 0);
    }

    function test_acceptInitializer_emitsEvent() public {
        address newInit = address(0xABCD);
        address newAdapter = address(0xEF01);

        vm.prank(admin);
        registry.proposeInitializer(newInit, newAdapter);
        vm.warp(block.timestamp + 48 hours);

        vm.prank(admin);
        vm.expectEmit(true, true, false, false);
        emit AstralaunchRegistry.InitializerAccepted(newInit, newAdapter);
        registry.acceptInitializer();
    }

    function test_acceptInitializer_revertsIfNotAdmin() public {
        vm.prank(admin);
        registry.proposeInitializer(address(0xABCD), address(0xEF01));
        vm.warp(block.timestamp + 48 hours);

        vm.expectRevert(AstralaunchRegistry.NotAdmin.selector);
        registry.acceptInitializer();
    }

    function test_acceptInitializer_revertsIfNoProposal() public {
        vm.prank(admin);
        vm.expectRevert(AstralaunchRegistry.NoActiveProposal.selector);
        registry.acceptInitializer();
    }

    function test_acceptInitializer_revertsBeforeDelay() public {
        vm.prank(admin);
        registry.proposeInitializer(address(0xABCD), address(0xEF01));
        vm.warp(block.timestamp + 48 hours - 1);

        vm.prank(admin);
        vm.expectRevert(AstralaunchRegistry.ProposalNotReady.selector);
        registry.acceptInitializer();
    }

    function test_cancelInitializerProposal_byAdmin() public {
        vm.prank(admin);
        registry.proposeInitializer(address(0xABCD), address(0xEF01));

        vm.prank(admin);
        registry.cancelInitializerProposal();

        (,, uint256 execAt) = registry.pendingInitializer();
        assertEq(execAt, 0);
    }

    function test_cancelInitializerProposal_byGuardian() public {
        vm.prank(admin);
        registry.proposeInitializer(address(0xABCD), address(0xEF01));

        vm.prank(guardian);
        registry.cancelInitializerProposal();

        (,, uint256 execAt) = registry.pendingInitializer();
        assertEq(execAt, 0);
    }

    function test_cancelInitializerProposal_emitsEvent() public {
        address newInit = address(0xABCD);
        vm.prank(admin);
        registry.proposeInitializer(newInit, address(0xEF01));

        vm.prank(admin);
        vm.expectEmit(true, false, false, false);
        emit AstralaunchRegistry.InitializerProposalCancelled(newInit);
        registry.cancelInitializerProposal();
    }

    function test_cancelInitializerProposal_revertsIfNoProposal() public {
        vm.prank(admin);
        vm.expectRevert(AstralaunchRegistry.NoActiveProposal.selector);
        registry.cancelInitializerProposal();
    }

    function test_cancelInitializerProposal_revertsIfNotAdminOrGuardian() public {
        vm.prank(admin);
        registry.proposeInitializer(address(0xABCD), address(0xEF01));

        vm.expectRevert(AstralaunchRegistry.NotAdminOrGuardian.selector);
        registry.cancelInitializerProposal();
    }

    function test_guardian_cannotProposeInitializer() public {
        vm.prank(guardian);
        vm.expectRevert(AstralaunchRegistry.NotAdmin.selector);
        registry.proposeInitializer(address(0xABCD), address(0xEF01));
    }

    function test_guardian_cannotAcceptInitializer() public {
        vm.prank(admin);
        registry.proposeInitializer(address(0xABCD), address(0xEF01));
        vm.warp(block.timestamp + 48 hours);

        vm.prank(guardian);
        vm.expectRevert(AstralaunchRegistry.NotAdmin.selector);
        registry.acceptInitializer();
    }

    // ── constructor: guardian set correctly ────────────────────────────────────
    function test_constructor_setsGuardian() public view {
        assertEq(registry.guardian(), guardian);
    }

    function test_constructor_revertsZeroGuardian() public {
        vm.expectRevert(AstralaunchRegistry.ZeroAddress.selector);
        new AstralaunchRegistry(
            address(pfr), address(escrow), address(vault), address(routerImpl),
            admin, address(0), INITIALIZER_ADDR, address(init_)
        );
    }

    function test_constructor_seedsInitialInitializer() public view {
        assertTrue(registry.allowedInitializers(INITIALIZER_ADDR));
    }

    // ── Helpers ───────────────────────────────────────────────────────────────
    function _goodAirlockCfg() internal view returns (MockAirlock.AssetConfig memory) {
        return MockAirlock.AssetConfig({
            numeraire:       USDC_ADDR,
            timelock:        address(0),
            governance:      NOGOV,
            migrator:        NOMIG,
            poolInitializer: INITIALIZER_ADDR,
            pool:            address(0),
            migrationPool:   address(0),
            numTokensToSell: C.POOL_TOKENS_NUM,
            totalSupply:     C.TOTAL_SUPPLY,
            integrator:      address(pfr)
        });
    }
}

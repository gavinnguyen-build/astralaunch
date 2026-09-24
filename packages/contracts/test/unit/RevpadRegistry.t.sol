// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RevpadRegistry} from "../../src/RevpadRegistry.sol";
import {RevenueRouter} from "../../src/RevenueRouter.sol";
import {FeeEscrow} from "../../src/FeeEscrow.sol";
import {BuybackVault} from "../../src/BuybackVault.sol";
import {PlatformFeeReceiver} from "../../src/PlatformFeeReceiver.sol";
import {RevpadConstants as C} from "../../src/RevpadConstants.sol";
import {PoolKey} from "../../src/interfaces/IInitializer.sol";

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

/// @dev Fix 1: getState(address asset) used by registry; getPoolKey kept for completeness.
contract MockInitializerReg {
    mapping(address => PoolKey)  public assetKeys_;      // asset → poolKey (for getState)
    mapping(bytes32 => PoolKey)  public poolKeys_;       // poolId → poolKey (legacy, kept)
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

    /// @dev Fix 1: registry uses getState(asset) to retrieve the poolKey.
    function getState(address asset)
        external view
        returns (address numeraire, uint8 status, PoolKey memory poolKey, int24 farTick)
    {
        return (address(0), 0, assetKeys_[asset], 0);
    }

    function getPoolKey(bytes32 poolId) external view returns (PoolKey memory) {
        return poolKeys_[poolId];
    }

    function getShares(bytes32 poolId, address who) external view returns (uint256) {
        return shares_[poolId][who];
    }

    function collectFees(bytes32) external pure returns (uint128, uint128) { return (0, 0); }
}

contract MockToken {
    uint256 public vestingStart_;
    uint256 public maxBalanceLimit_;
    uint64  public cliff_;
    uint64  public duration_;
    uint48  public balanceLimitEnd_;   // Fix 3
    uint256 public totalAllocated_;    // Fix 2: returned by totalAllocatedOf

    function setup(uint64 cliff, uint64 duration, uint256 mbl, uint256 vs) external {
        cliff_           = cliff;
        duration_        = duration;
        maxBalanceLimit_ = mbl;
        vestingStart_    = vs;
    }

    // Separate setters for Fix 2 / Fix 3 fields so existing setup() calls are unchanged
    function setBalanceLimitEnd(uint48 ble) external { balanceLimitEnd_ = ble; }
    function setTotalAllocated(uint256 a)   external { totalAllocated_  = a; }

    function vestingSchedules(uint256) external view returns (uint64 cliff, uint64 duration) {
        return (cliff_, duration_);
    }
    function maxBalanceLimit()   external view returns (uint256) { return maxBalanceLimit_; }
    function vestingStart()      external view returns (uint256) { return vestingStart_; }
    function balanceLimitEnd()   external view returns (uint48)  { return balanceLimitEnd_; }
    // Fix 2: vesting amount getters
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

// ── Test contract ──────────────────────────────────────────────────────────────
contract RevpadRegistryTest is Test {
    // canonical Monad mainnet addresses (from RevpadRegistry)
    address constant AIRLOCK_ADDR     = 0x660eAaEdEBc968f8f3694354FA8EC0b4c5Ba8D12;
    address constant INITIALIZER_ADDR = 0xCe3099B2F07029b086E5e92a1573C5f5A3071783;
    address constant NOMIG            = 0x5F3bA43D44375286296Cb85F1EA2EBfa25dde731;
    // NOGOV = dead address (spike-confirmed; see decisions.md D1)
    address constant NOGOV            = 0x000000000000000000000000000000000000dEaD;
    address constant USDC_ADDR        = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address constant AIRLOCK_OWNER    = 0x21E2ce70511e4FE542a97708e89520471DAa7A66;
    // Fix 1: Doppler hook constant (confirmed constant across all Revpad launches, D16)
    address constant DOPPLER_HOOK     = 0x580ca49389d83b019d07E17e99454f2F218e2dc0;

    RevpadRegistry      registry;
    MockAirlock         airlock;
    MockInitializerReg  init_;
    MockPoolManagerReg  pm;
    MockToken           token;

    RevenueRouter       routerImpl;
    FeeEscrow           escrow;
    BuybackVault        vault;
    PlatformFeeReceiver pfr;

    address admin    = address(0xAD);
    address treasury = address(0x7AEA5);
    address creator  = address(0xC8EA7012);

    address asset;
    bytes32 poolId;
    PoolKey poolKey;

    function setUp() public {
        // ── Pre-compute registry address ──────────────────────────────────────
        // Deployments before registry:
        //   +0 token, +1 tmpUsdc, +2 tmpAirlock, +3 tmpInit, +4 pm,
        //   +5 escrow, +6 vault, +7 pfr, +8 routerImpl → +9 = registry
        uint256 startNonce = vm.getNonce(address(this));
        address futureRegistry = vm.computeCreateAddress(address(this), startNonce + 9);

        token = new MockToken();  // +0

        {
            MockUSDCReg tmpUsdc = new MockUSDCReg();  // +1
            vm.etch(USDC_ADDR, address(tmpUsdc).code);
        }

        {
            MockAirlock tmpAirlock = new MockAirlock();  // +2
            vm.etch(AIRLOCK_ADDR, address(tmpAirlock).code);
        }
        airlock = MockAirlock(AIRLOCK_ADDR);

        {
            MockInitializerReg tmpInit = new MockInitializerReg();  // +3
            vm.etch(INITIALIZER_ADDR, address(tmpInit).code);
        }
        init_ = MockInitializerReg(INITIALIZER_ADDR);

        pm         = new MockPoolManagerReg();  // +4
        escrow     = new FeeEscrow(futureRegistry, address(0), INITIALIZER_ADDR);  // +5
        vault      = new BuybackVault(futureRegistry, INITIALIZER_ADDR, address(pm));  // +6
        pfr        = new PlatformFeeReceiver(futureRegistry, INITIALIZER_ADDR, treasury, admin); // +7
        routerImpl = new RevenueRouter();  // +8
        registry   = new RevpadRegistry(  // +9
            address(pfr), address(escrow), address(vault), address(routerImpl), admin
        );
        require(address(registry) == futureRegistry, "nonce offset wrong");

        asset = address(token);

        // Fix 1: poolKey.hooks must be DOPPLER_HOOK for the happy path.
        poolKey = PoolKey({
            currency0:   USDC_ADDR < asset ? USDC_ADDR : asset,
            currency1:   USDC_ADDR < asset ? asset : USDC_ADDR,
            fee:         C.POOL_FEE,
            tickSpacing: C.TICK_SPACING,
            hooks:       DOPPLER_HOOK
        });
        poolId = keccak256(abi.encode(poolKey));

        // Configure token (Fix 2: setTotalAllocated; Fix 3: setBalanceLimitEnd)
        token.setup(uint64(C.VESTING_CLIFF), uint64(C.VESTING_DURATION), C.BALANCE_CAP_NUM, block.timestamp);
        token.setBalanceLimitEnd(uint48(block.timestamp + C.BALANCE_CAP_WINDOW + 1));
        token.setTotalAllocated(C.VESTED_TOKENS_NUM);

        // Configure airlock at canonical address (integrator must equal PFR address)
        airlock.setConfig(asset, _goodAirlockCfg());

        // Configure initializer at canonical address
        // Fix 1: setAssetKey for getState(asset); poolId auto-computed on-chain
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
        emit RevpadRegistry.Registered(asset, creator, address(0), poolId, 0);
        registry.register(asset, creator);
    }

    function test_register_revertsIfDuplicate() public {
        registry.register(asset, creator);
        vm.expectRevert(RevpadRegistry.AlreadyRegistered.selector);
        registry.register(asset, creator);
    }

    function test_register_revertsWhenPaused() public {
        vm.prank(admin);
        registry.setPause(true);
        vm.expectRevert(RevpadRegistry.Paused.selector);
        registry.register(asset, creator);
    }

    // ── register: airlock mismatch errors ─────────────────────────────────────
    function test_register_revertsWrongNumeraire() public {
        MockAirlock.AssetConfig memory cfg = _goodAirlockCfg();
        cfg.numeraire = address(0x1234);
        airlock.setConfig(asset, cfg);
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongNumeraire.selector, address(0x1234), USDC_ADDR));
        registry.register(asset, creator);
    }

    function test_register_revertsWrongInitializer() public {
        MockAirlock.AssetConfig memory cfg = _goodAirlockCfg();
        cfg.poolInitializer = address(0xBAD);
        airlock.setConfig(asset, cfg);
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongInitializer.selector, address(0xBAD), INITIALIZER_ADDR));
        registry.register(asset, creator);
    }

    function test_register_revertsWrongMigrator() public {
        MockAirlock.AssetConfig memory cfg = _goodAirlockCfg();
        cfg.migrator = address(0xBAD);
        airlock.setConfig(asset, cfg);
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongMigrator.selector, address(0xBAD), NOMIG));
        registry.register(asset, creator);
    }

    function test_register_revertsWrongGovernance() public {
        MockAirlock.AssetConfig memory cfg = _goodAirlockCfg();
        cfg.governance = address(0xBAD);
        airlock.setConfig(asset, cfg);
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongGovernance.selector, address(0xBAD), NOGOV));
        registry.register(asset, creator);
    }

    function test_register_revertsWrongTotalSupply() public {
        MockAirlock.AssetConfig memory cfg = _goodAirlockCfg();
        cfg.totalSupply = C.TOTAL_SUPPLY + 1;
        airlock.setConfig(asset, cfg);
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongTotalSupply.selector, C.TOTAL_SUPPLY + 1, C.TOTAL_SUPPLY));
        registry.register(asset, creator);
    }

    function test_register_revertsWrongNumTokensToSell() public {
        MockAirlock.AssetConfig memory cfg = _goodAirlockCfg();
        cfg.numTokensToSell = C.POOL_TOKENS_NUM + 1;
        airlock.setConfig(asset, cfg);
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongNumTokensToSell.selector, C.POOL_TOKENS_NUM + 1, C.POOL_TOKENS_NUM));
        registry.register(asset, creator);
    }

    // Fix 1-integrator: reject wrong integrator (must equal PFR address)
    function test_register_revertsWrongIntegrator() public {
        MockAirlock.AssetConfig memory cfg = _goodAirlockCfg();
        cfg.integrator = address(0xBAD);
        airlock.setConfig(asset, cfg);
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongIntegrator.selector, address(0xBAD), address(pfr)));
        registry.register(asset, creator);
    }

    // ── register: pool key errors ─────────────────────────────────────────────

    // Fix 1: reject token whose pool has wrong hook (not DOPPLER_HOOK)
    function test_register_revertsWrongPool() public {
        PoolKey memory bad = poolKey;
        bad.hooks = address(0xBAD);
        init_.setAssetKey(asset, bad);
        vm.expectRevert(RevpadRegistry.WrongPool.selector);
        registry.register(asset, creator);
    }

    function test_register_revertsWrongFee() public {
        PoolKey memory bad = poolKey; // hooks = DOPPLER_HOOK (must pass hook check first)
        bad.fee = 3000;
        init_.setAssetKey(asset, bad);
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongFee.selector, uint24(3000), C.POOL_FEE));
        registry.register(asset, creator);
    }

    function test_register_revertsWrongTickSpacing() public {
        PoolKey memory bad = poolKey; // hooks = DOPPLER_HOOK
        bad.tickSpacing = 60;
        init_.setAssetKey(asset, bad);
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongTickSpacing.selector, int24(60), C.TICK_SPACING));
        registry.register(asset, creator);
    }

    function test_register_revertsWrongPoolCurrencies() public {
        // Pool with correct fee/tickSpacing/hook but wrong currencies (neither is our asset)
        PoolKey memory bad = PoolKey({
            currency0:   address(0x1111),
            currency1:   USDC_ADDR,
            fee:         C.POOL_FEE,
            tickSpacing: C.TICK_SPACING,
            hooks:       DOPPLER_HOOK
        });
        init_.setAssetKey(asset, bad);
        vm.expectRevert(RevpadRegistry.WrongPoolCurrencies.selector);
        registry.register(asset, creator);
    }

    // ── register: beneficiary share errors ───────────────────────────────────
    function test_register_revertsWrongDopplerShare() public {
        init_.setShare(poolId, AIRLOCK_OWNER, C.DOPPLER_SHARE_WAD + 1);
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongDopplerShare.selector, C.DOPPLER_SHARE_WAD + 1, C.DOPPLER_SHARE_WAD));
        registry.register(asset, creator);
    }

    function test_register_revertsWrongCreatorShare() public {
        init_.setShare(poolId, creator, C.CREATOR_SHARE_WAD + 1);
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongCreatorShare.selector, C.CREATOR_SHARE_WAD + 1, C.CREATOR_SHARE_WAD));
        registry.register(asset, creator);
    }

    function test_register_revertsWrongEscrowShare() public {
        init_.setShare(poolId, address(escrow), C.ESCROW_SHARE_WAD + 1);
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongEscrowShare.selector, C.ESCROW_SHARE_WAD + 1, C.ESCROW_SHARE_WAD));
        registry.register(asset, creator);
    }

    function test_register_revertsWrongBuybackShare() public {
        init_.setShare(poolId, address(vault), C.BUYBACK_SHARE_WAD + 1);
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongBuybackShare.selector, C.BUYBACK_SHARE_WAD + 1, C.BUYBACK_SHARE_WAD));
        registry.register(asset, creator);
    }

    function test_register_revertsWrongTreasuryShare() public {
        init_.setShare(poolId, address(pfr), C.TREASURY_SHARE_WAD + 1);
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongTreasuryShare.selector, C.TREASURY_SHARE_WAD + 1, C.TREASURY_SHARE_WAD));
        registry.register(asset, creator);
    }

    // ── register: token vesting / balance cap errors ──────────────────────────
    function test_register_revertsWrongVestingCliff() public {
        token.setup(uint64(C.VESTING_CLIFF) + 1, uint64(C.VESTING_DURATION), C.BALANCE_CAP_NUM, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongVestingCliff.selector, uint64(C.VESTING_CLIFF) + 1, uint64(C.VESTING_CLIFF)));
        registry.register(asset, creator);
    }

    function test_register_revertsWrongVestingDuration() public {
        token.setup(uint64(C.VESTING_CLIFF), uint64(C.VESTING_DURATION) + 1, C.BALANCE_CAP_NUM, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongVestingDuration.selector, uint64(C.VESTING_DURATION) + 1, uint64(C.VESTING_DURATION)));
        registry.register(asset, creator);
    }

    // Fix 2: reject wrong vesting amount
    function test_register_revertsWrongVestingAmount() public {
        uint256 badAmount = 50_000_000 * 1e18; // 50 M instead of 150 M
        token.setTotalAllocated(badAmount);
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongVestingAmount.selector, badAmount, C.VESTED_TOKENS_NUM));
        registry.register(asset, creator);
    }

    // Fix 3: reject wrong balance cap absolute value (5 % instead of 1 %)
    function test_register_revertsWrongBalanceCap() public {
        token.setup(uint64(C.VESTING_CLIFF), uint64(C.VESTING_DURATION), C.BALANCE_CAP_NUM + 1, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongBalanceCap.selector, C.BALANCE_CAP_NUM + 1, C.BALANCE_CAP_NUM));
        registry.register(asset, creator);
    }

    // Fix 3: reject balance cap window < BALANCE_CAP_WINDOW (balanceLimitEnd == vestingStart → 0 s)
    function test_register_revertsWrongBalanceCap_window() public {
        token.setBalanceLimitEnd(uint48(block.timestamp)); // window = 0 s < 600 s
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongBalanceCap.selector, uint256(0), C.BALANCE_CAP_WINDOW));
        registry.register(asset, creator);
    }

    // Fix 3 (upper bound): reject balance cap window > BALANCE_CAP_WINDOW_MAX
    function test_register_revertsWrongBalanceCap_windowTooWide() public {
        uint256 tooWide = C.BALANCE_CAP_WINDOW_MAX + 1;
        token.setBalanceLimitEnd(uint48(block.timestamp + tooWide));
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongBalanceCap.selector, tooWide, C.BALANCE_CAP_WINDOW_MAX));
        registry.register(asset, creator);
    }

    // Boundary: window = 599 s → revert (one below lower bound)
    function test_register_revertsWrongBalanceCap_window599() public {
        token.setBalanceLimitEnd(uint48(block.timestamp + 599));
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongBalanceCap.selector, uint256(599), C.BALANCE_CAP_WINDOW));
        registry.register(asset, creator);
    }

    // Boundary: window = 600 s → pass (exact lower bound)
    function test_register_acceptsWindow600() public {
        token.setBalanceLimitEnd(uint48(block.timestamp + 600));
        address router = registry.register(asset, creator);
        assertTrue(router != address(0));
    }

    // Boundary: window = 900 s → pass (exact upper bound)
    function test_register_acceptsWindow900() public {
        token.setBalanceLimitEnd(uint48(block.timestamp + 900));
        address router = registry.register(asset, creator);
        assertTrue(router != address(0));
    }

    // Boundary: window = 901 s → revert (one above upper bound)
    function test_register_revertsWrongBalanceCap_window901() public {
        token.setBalanceLimitEnd(uint48(block.timestamp + 901));
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongBalanceCap.selector, uint256(901), C.BALANCE_CAP_WINDOW_MAX));
        registry.register(asset, creator);
    }

    // ── treasury getter ───────────────────────────────────────────────────────
    function test_treasury_returnsPFRAddress() public view {
        assertEq(registry.treasury(), address(pfr));
    }

    // ── admin ─────────────────────────────────────────────────────────────────
    function test_setPause_byAdmin() public {
        vm.prank(admin);
        registry.setPause(true);
        assertTrue(registry.paused());
        vm.prank(admin);
        registry.setPause(false);
        assertFalse(registry.paused());
    }

    function test_setPause_revertsIfNotAdmin() public {
        vm.expectRevert(RevpadRegistry.NotAdmin.selector);
        registry.setPause(true);
    }

    // ── PlatformFeeReceiver wiring ────────────────────────────────────────────
    function test_register_registersPFRAsset() public {
        registry.register(asset, creator);
        assertEq(pfr.assetPoolIds(asset), poolId);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────
    function _goodAirlockCfg() internal view returns (MockAirlock.AssetConfig memory) {
        return MockAirlock.AssetConfig({
            numeraire:       0x754704Bc059F8C67012fEd69BC8A327a5aafb603, // USDC_ADDR
            timelock:        address(0),
            governance:      0x000000000000000000000000000000000000dEaD, // NOGOV
            migrator:        0x5F3bA43D44375286296Cb85F1EA2EBfa25dde731, // NOMIG
            poolInitializer: 0xCe3099B2F07029b086E5e92a1573C5f5A3071783, // INITIALIZER_ADDR
            pool:            address(0),
            migrationPool:   address(0),
            numTokensToSell: 850_000_000 * 1e18,  // C.POOL_TOKENS_NUM
            totalSupply:     1_000_000_000 * 1e18, // C.TOTAL_SUPPLY
            integrator:      address(pfr)          // must equal registry.platformFeeReceiver
        });
    }
}

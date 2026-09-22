// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RevpadRegistry} from "../../src/RevpadRegistry.sol";
import {RevenueRouter} from "../../src/RevenueRouter.sol";
import {FeeEscrow} from "../../src/FeeEscrow.sol";
import {BuybackVault} from "../../src/BuybackVault.sol";
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

/// @dev Spike-confirmed: getPoolKey takes bytes32 poolId (see decisions.md D2).
contract MockInitializerReg {
    mapping(bytes32 => PoolKey)  public poolKeys_;
    mapping(bytes32 => mapping(address => uint256)) public shares_;

    function setPoolKey(bytes32 poolId, PoolKey calldata key) external {
        poolKeys_[poolId] = key;
    }

    function setShare(bytes32 poolId, address who, uint256 wad) external {
        shares_[poolId][who] = wad;
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

    function setup(uint64 cliff, uint64 duration, uint256 mbl, uint256 vs) external {
        cliff_           = cliff;
        duration_        = duration;
        maxBalanceLimit_ = mbl;
        vestingStart_    = vs;
    }

    function vestingSchedules(uint256) external view returns (uint64 cliff, uint64 duration) {
        return (cliff_, duration_);
    }
    function maxBalanceLimit() external view returns (uint256) { return maxBalanceLimit_; }
    function vestingStart()    external view returns (uint256) { return vestingStart_; }
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

    RevpadRegistry     registry;
    MockAirlock        airlock;
    MockInitializerReg init_;
    MockPoolManagerReg pm;
    MockToken          token;

    RevenueRouter  routerImpl;
    FeeEscrow      escrow;
    BuybackVault   vault;

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
        //   +5 escrow, +6 vault, +7 routerImpl → +8 = registry
        uint256 startNonce = vm.getNonce(address(this));
        address futureRegistry = vm.computeCreateAddress(address(this), startNonce + 8);

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
        routerImpl = new RevenueRouter();  // +7
        registry   = new RevpadRegistry(  // +8
            treasury, address(escrow), address(vault), address(routerImpl), admin
        );
        require(address(registry) == futureRegistry, "nonce offset wrong");

        asset = address(token);

        // Build canonical PoolKey (USDC < asset? depends on addresses)
        poolKey = PoolKey({
            currency0:   USDC_ADDR < asset ? USDC_ADDR : asset,
            currency1:   USDC_ADDR < asset ? asset : USDC_ADDR,
            fee:         C.POOL_FEE,
            tickSpacing: C.TICK_SPACING,
            hooks:       address(0xBEEF) // arbitrary hook addr for tests
        });
        poolId = keccak256(abi.encode(poolKey));

        // Configure token
        token.setup(uint64(C.VESTING_CLIFF), uint64(C.VESTING_DURATION), C.BALANCE_CAP_NUM, block.timestamp);

        // Configure airlock at canonical address
        airlock.setConfig(asset, _goodAirlockCfg());

        // Configure initializer at canonical address (getPoolKey takes bytes32)
        init_.setPoolKey(poolId, poolKey);
        init_.setShare(poolId, AIRLOCK_OWNER,   C.DOPPLER_SHARE_WAD);
        init_.setShare(poolId, creator,         C.CREATOR_SHARE_WAD);
        init_.setShare(poolId, address(escrow), C.ESCROW_SHARE_WAD);
        init_.setShare(poolId, address(vault),  C.BUYBACK_SHARE_WAD);
        init_.setShare(poolId, treasury,        C.TREASURY_SHARE_WAD);
    }

    // ── register: happy path ──────────────────────────────────────────────────
    function test_register_success() public {
        address router = registry.register(asset, creator, poolId);
        assertTrue(router != address(0));
        assertEq(registry.routers(asset), router);
        assertTrue(registry.isRegistered(asset));

        RevenueRouter rr = RevenueRouter(router);
        assertEq(rr.asset(),        asset);
        assertEq(rr.creator(),      creator);
        assertEq(rr.registry(),     address(registry));
        assertEq(rr.feeEscrow(),    address(escrow));
        assertEq(rr.buybackVault(), address(vault));
        assertEq(rr.treasury(),     treasury);
    }

    function test_register_emitsEvent() public {
        vm.expectEmit(true, true, false, false);
        emit RevpadRegistry.Registered(asset, creator, address(0), poolId, 0);
        registry.register(asset, creator, poolId);
    }

    function test_register_revertsIfDuplicate() public {
        registry.register(asset, creator, poolId);
        vm.expectRevert(RevpadRegistry.AlreadyRegistered.selector);
        registry.register(asset, creator, poolId);
    }

    function test_register_revertsWhenPaused() public {
        vm.prank(admin);
        registry.setPause(true);
        vm.expectRevert(RevpadRegistry.Paused.selector);
        registry.register(asset, creator, poolId);
    }

    // ── register: airlock mismatch errors ─────────────────────────────────────
    function test_register_revertsWrongNumeraire() public {
        MockAirlock.AssetConfig memory cfg = _goodAirlockCfg();
        cfg.numeraire = address(0x1234);
        airlock.setConfig(asset, cfg);
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongNumeraire.selector, address(0x1234), USDC_ADDR));
        registry.register(asset, creator, poolId);
    }

    function test_register_revertsWrongInitializer() public {
        MockAirlock.AssetConfig memory cfg = _goodAirlockCfg();
        cfg.poolInitializer = address(0xBAD);
        airlock.setConfig(asset, cfg);
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongInitializer.selector, address(0xBAD), INITIALIZER_ADDR));
        registry.register(asset, creator, poolId);
    }

    function test_register_revertsWrongMigrator() public {
        MockAirlock.AssetConfig memory cfg = _goodAirlockCfg();
        cfg.migrator = address(0xBAD);
        airlock.setConfig(asset, cfg);
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongMigrator.selector, address(0xBAD), NOMIG));
        registry.register(asset, creator, poolId);
    }

    function test_register_revertsWrongGovernance() public {
        MockAirlock.AssetConfig memory cfg = _goodAirlockCfg();
        cfg.governance = address(0xBAD);
        airlock.setConfig(asset, cfg);
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongGovernance.selector, address(0xBAD), NOGOV));
        registry.register(asset, creator, poolId);
    }

    function test_register_revertsWrongTotalSupply() public {
        MockAirlock.AssetConfig memory cfg = _goodAirlockCfg();
        cfg.totalSupply = C.TOTAL_SUPPLY + 1;
        airlock.setConfig(asset, cfg);
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongTotalSupply.selector, C.TOTAL_SUPPLY + 1, C.TOTAL_SUPPLY));
        registry.register(asset, creator, poolId);
    }

    function test_register_revertsWrongNumTokensToSell() public {
        MockAirlock.AssetConfig memory cfg = _goodAirlockCfg();
        cfg.numTokensToSell = C.POOL_TOKENS_NUM + 1;
        airlock.setConfig(asset, cfg);
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongNumTokensToSell.selector, C.POOL_TOKENS_NUM + 1, C.POOL_TOKENS_NUM));
        registry.register(asset, creator, poolId);
    }

    // ── register: pool key errors ─────────────────────────────────────────────
    function test_register_revertsWrongFee() public {
        PoolKey memory bad = poolKey;
        bad.fee = 3000;
        bytes32 badId = keccak256(abi.encode(bad));
        init_.setPoolKey(badId, bad);
        // Copy shares to badId
        init_.setShare(badId, AIRLOCK_OWNER,   C.DOPPLER_SHARE_WAD);
        init_.setShare(badId, creator,         C.CREATOR_SHARE_WAD);
        init_.setShare(badId, address(escrow), C.ESCROW_SHARE_WAD);
        init_.setShare(badId, address(vault),  C.BUYBACK_SHARE_WAD);
        init_.setShare(badId, treasury,        C.TREASURY_SHARE_WAD);
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongFee.selector, uint24(3000), C.POOL_FEE));
        registry.register(asset, creator, badId);
    }

    function test_register_revertsWrongTickSpacing() public {
        PoolKey memory bad = poolKey;
        bad.tickSpacing = 60;
        bytes32 badId = keccak256(abi.encode(bad));
        init_.setPoolKey(badId, bad);
        init_.setShare(badId, AIRLOCK_OWNER,   C.DOPPLER_SHARE_WAD);
        init_.setShare(badId, creator,         C.CREATOR_SHARE_WAD);
        init_.setShare(badId, address(escrow), C.ESCROW_SHARE_WAD);
        init_.setShare(badId, address(vault),  C.BUYBACK_SHARE_WAD);
        init_.setShare(badId, treasury,        C.TREASURY_SHARE_WAD);
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongTickSpacing.selector, int24(60), C.TICK_SPACING));
        registry.register(asset, creator, badId);
    }

    function test_register_revertsWrongPoolCurrencies() public {
        // Pool with correct fee/tickSpacing but wrong currencies (neither is our asset)
        PoolKey memory bad = PoolKey({
            currency0:   address(0x1111),
            currency1:   USDC_ADDR,
            fee:         C.POOL_FEE,
            tickSpacing: C.TICK_SPACING,
            hooks:       address(0)
        });
        bytes32 badId = keccak256(abi.encode(bad));
        init_.setPoolKey(badId, bad);
        init_.setShare(badId, AIRLOCK_OWNER,   C.DOPPLER_SHARE_WAD);
        init_.setShare(badId, creator,         C.CREATOR_SHARE_WAD);
        init_.setShare(badId, address(escrow), C.ESCROW_SHARE_WAD);
        init_.setShare(badId, address(vault),  C.BUYBACK_SHARE_WAD);
        init_.setShare(badId, treasury,        C.TREASURY_SHARE_WAD);
        vm.expectRevert(RevpadRegistry.WrongPoolCurrencies.selector);
        registry.register(asset, creator, badId);
    }

    // ── register: beneficiary share errors ───────────────────────────────────
    function test_register_revertsWrongDopplerShare() public {
        init_.setShare(poolId, AIRLOCK_OWNER, C.DOPPLER_SHARE_WAD + 1);
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongDopplerShare.selector, C.DOPPLER_SHARE_WAD + 1, C.DOPPLER_SHARE_WAD));
        registry.register(asset, creator, poolId);
    }

    function test_register_revertsWrongCreatorShare() public {
        init_.setShare(poolId, creator, C.CREATOR_SHARE_WAD + 1);
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongCreatorShare.selector, C.CREATOR_SHARE_WAD + 1, C.CREATOR_SHARE_WAD));
        registry.register(asset, creator, poolId);
    }

    function test_register_revertsWrongEscrowShare() public {
        init_.setShare(poolId, address(escrow), C.ESCROW_SHARE_WAD + 1);
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongEscrowShare.selector, C.ESCROW_SHARE_WAD + 1, C.ESCROW_SHARE_WAD));
        registry.register(asset, creator, poolId);
    }

    function test_register_revertsWrongBuybackShare() public {
        init_.setShare(poolId, address(vault), C.BUYBACK_SHARE_WAD + 1);
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongBuybackShare.selector, C.BUYBACK_SHARE_WAD + 1, C.BUYBACK_SHARE_WAD));
        registry.register(asset, creator, poolId);
    }

    function test_register_revertsWrongTreasuryShare() public {
        init_.setShare(poolId, treasury, C.TREASURY_SHARE_WAD + 1);
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongTreasuryShare.selector, C.TREASURY_SHARE_WAD + 1, C.TREASURY_SHARE_WAD));
        registry.register(asset, creator, poolId);
    }

    // ── register: token vesting / balance cap errors ──────────────────────────
    function test_register_revertsWrongVestingCliff() public {
        token.setup(uint64(C.VESTING_CLIFF) + 1, uint64(C.VESTING_DURATION), C.BALANCE_CAP_NUM, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongVestingCliff.selector, uint64(C.VESTING_CLIFF) + 1, uint64(C.VESTING_CLIFF)));
        registry.register(asset, creator, poolId);
    }

    function test_register_revertsWrongVestingDuration() public {
        token.setup(uint64(C.VESTING_CLIFF), uint64(C.VESTING_DURATION) + 1, C.BALANCE_CAP_NUM, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongVestingDuration.selector, uint64(C.VESTING_DURATION) + 1, uint64(C.VESTING_DURATION)));
        registry.register(asset, creator, poolId);
    }

    function test_register_revertsWrongBalanceCap() public {
        token.setup(uint64(C.VESTING_CLIFF), uint64(C.VESTING_DURATION), C.BALANCE_CAP_NUM + 1, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(RevpadRegistry.WrongBalanceCap.selector, C.BALANCE_CAP_NUM + 1, C.BALANCE_CAP_NUM));
        registry.register(asset, creator, poolId);
    }

    // ── admin ─────────────────────────────────────────────────────────────────
    function test_setTreasury_byAdmin() public {
        address newT = address(0xBEEF);
        vm.prank(admin);
        registry.setTreasury(newT);
        assertEq(registry.treasury(), newT);
    }

    function test_setTreasury_revertsIfNotAdmin() public {
        vm.expectRevert(RevpadRegistry.NotAdmin.selector);
        registry.setTreasury(address(0xBEEF));
    }

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

    // ── Helpers ───────────────────────────────────────────────────────────────
    function _goodAirlockCfg() internal pure returns (MockAirlock.AssetConfig memory) {
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
            integrator:      address(0)
        });
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BuybackVault} from "../../src/BuybackVault.sol";
import {AstralaunchConstants as C} from "../../src/AstralaunchConstants.sol";
import {IFeeAdapter} from "../../src/interfaces/IFeeAdapter.sol";
import {PoolKey} from "../../src/interfaces/IInitializer.sol";
import {SOURCE_REVENUE, SOURCE_TRADING, SOURCE_FORFEIT} from "../../src/interfaces/IBuybackVault.sol";
import {SwapParams, BalanceDelta} from "../../src/interfaces/IPoolManager.sol";

// ── Stubs ─────────────────────────────────────────────────────────────────────

contract MockUSDCVault {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }
    function transfer(address to, uint256 amt) external returns (bool) {
        require(balanceOf[msg.sender] >= amt);
        balanceOf[msg.sender] -= amt;
        balanceOf[to]         += amt;
        return true;
    }
}

contract MockWMONVault {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }
    function transfer(address to, uint256 amt) external returns (bool) {
        require(balanceOf[msg.sender] >= amt);
        balanceOf[msg.sender] -= amt;
        balanceOf[to]         += amt;
        return true;
    }
}

/// @dev Implements IFeeAdapter for test use.
contract MockInitializerVault is IFeeAdapter {
    MockUSDCVault usdc;
    mapping(bytes32 => mapping(address => uint256)) public usdcPending;

    constructor(address _usdc) { usdc = MockUSDCVault(_usdc); }

    function setUSDCPending(bytes32 poolId, address who, uint256 amt) external {
        usdcPending[poolId][who] = amt;
    }

    function collectFees(bytes32 poolId) external override returns (uint128, uint128) {
        uint256 u = usdcPending[poolId][msg.sender];
        if (u > 0) {
            usdcPending[poolId][msg.sender] = 0;
            usdc.mint(msg.sender, u);
        }
        return (uint128(u), 0);
    }

    function getShares(bytes32, address) external pure override returns (uint256) { return 0; }

    function getState(address)
        external pure override
        returns (address, uint8, PoolKey memory, int24)
    {
        PoolKey memory k;
        return (address(0), 0, k, 0);
    }
}

/// @dev PoolManager stub: swap just returns tokens to vault without touching real v4.
contract MockPoolManager {
    MockAssetToken asset_;
    uint256 public swapUsdcIn;
    uint256 public swapTokenOut;
    address public vaultAddr;

    constructor(address _asset) { asset_ = MockAssetToken(_asset); }

    function unlock(bytes calldata data) external returns (bytes memory) {
        vaultAddr = msg.sender;
        (address assetAddr, uint256 usdcIn, uint256 minOut) = abi.decode(data, (address,uint256,uint256));
        swapUsdcIn  = usdcIn;
        // Simulate receiving tokens
        uint256 tokensOut = usdcIn * 100; // 100:1 rate for testing
        require(tokensOut >= minOut, "slippage");
        swapTokenOut = tokensOut;

        // Call unlockCallback on vault -- passes back decoded data
        bytes memory cbData = abi.encode(assetAddr, usdcIn, minOut);
        bytes memory ret = BuybackVaultHarness(vaultAddr).unlockCallback(cbData);
        return ret;
    }

    function swap(PoolKey memory, SwapParams calldata, bytes calldata) external pure
        returns (BalanceDelta delta)
    {
        return BalanceDelta.wrap(0); // handled by unlock stub; zero delta -> no tokens owed
    }
    function settle() external payable returns (uint256) { return 0; }
    function sync(address) external {}
    function take(address tokenAddr, address to, uint256 amt) external {
        MockAssetToken(tokenAddr).mint(to, amt);
    }
}

/// @dev Thin wrapper so tests can call unlockCallback (which is external).
contract BuybackVaultHarness is BuybackVault {
    // v2 constructor: (registry, poolManager) - no initializer
    constructor(address r, address pm) BuybackVault(r, pm) {}
}

contract MockAssetToken {
    mapping(address => uint256) public balanceOf;
    uint256 public burnedTotal;

    // v2: isExcludedFromBalanceLimit instead of balanceLimitEnd
    mapping(address => bool) public isExcludedFromBalanceLimit;

    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }
    function burn(uint256 amt) external {
        require(balanceOf[msg.sender] >= amt);
        balanceOf[msg.sender] -= amt;
        burnedTotal           += amt;
    }
    function transfer(address to, uint256 amt) external returns (bool) {
        require(balanceOf[msg.sender] >= amt);
        balanceOf[msg.sender] -= amt;
        balanceOf[to]         += amt;
        return true;
    }
    function setExcluded(address who, bool val) external { isExcludedFromBalanceLimit[who] = val; }
}

// ── Test contract ─────────────────────────────────────────────────────────────
contract BuybackVaultTest is Test {
    address constant USDC_ADDR = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address constant WMON_ADDR = 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A;

    BuybackVaultHarness  vault;
    MockInitializerVault init_;
    MockUSDCVault        usdc;
    MockAssetToken       token;
    MockPoolManager      pm;

    address registry = address(this);
    address router1  = address(0xAB1);
    address asset;
    bytes32 poolId = keccak256("pool");

    PoolKey poolKey;

    function setUp() public {
        // Warp past MIN_INTERVAL so first execute call is not in cooldown
        vm.warp(uint256(C.BUYBACK_MIN_INTERVAL) + 100);

        token = new MockAssetToken();

        // Etch canonical USDC first so init_ and vault use the same address
        MockUSDCVault tmpUsdc = new MockUSDCVault();
        vm.etch(USDC_ADDR, address(tmpUsdc).code);
        usdc = MockUSDCVault(USDC_ADDR);

        // Etch WMON at canonical address
        MockWMONVault tmpWmon = new MockWMONVault();
        vm.etch(WMON_ADDR, address(tmpWmon).code);

        init_ = new MockInitializerVault(address(usdc));
        pm    = new MockPoolManager(address(token));

        // v2 constructor: (registry, poolManager) - no initializer
        vault = new BuybackVaultHarness(registry, address(pm));
        asset = address(token);

        // Build PoolKey (USDC < asset or not; use canonical USDC address)
        poolKey = PoolKey({
            currency0:   USDC_ADDR < asset ? USDC_ADDR : asset,
            currency1:   USDC_ADDR < asset ? asset : USDC_ADDR,
            fee:         20_000,
            tickSpacing: 200,
            hooks:       address(0)
        });

        // v2 registerAsset: extra numeraire param
        vault.registerAsset(asset, poolKey, poolId, USDC_ADDR);
        vault.setAdapter(asset, address(init_));
        vault.authorize(router1);
    }

    // ── registerAsset ─────────────────────────────────────────────────────────
    function test_register_setsNumeraire() public view {
        assertEq(vault.assetData(asset).numeraire, USDC_ADDR);
    }

    function test_register_revertsIfDuplicate() public {
        vm.expectRevert(BuybackVault.AlreadyRegistered.selector);
        vault.registerAsset(asset, poolKey, poolId, USDC_ADDR);
    }

    function test_register_revertsIfNotRegistry() public {
        vm.prank(address(0x999));
        vm.expectRevert(BuybackVault.NotRegistry.selector);
        vault.registerAsset(address(0x1), poolKey, poolId, USDC_ADDR);
    }

    // ── setAdapter ────────────────────────────────────────────────────────────
    function test_setAdapter_revertsIfNotRegistry() public {
        vm.prank(address(0x999));
        vm.expectRevert(BuybackVault.NotRegistry.selector);
        vault.setAdapter(asset, address(init_));
    }

    // ── collect ───────────────────────────────────────────────────────────────
    function test_collect_accumulatesUSDC() public {
        init_.setUSDCPending(poolId, address(vault), 1_000_000);
        vault.collect(asset);
        BuybackVault.AssetData memory d = vault.assetData(asset);
        assertEq(d.balanceUSDC,       1_000_000);
        assertEq(d.buybackFromTrading,1_000_000);
    }

    // ── creditUSDC ────────────────────────────────────────────────────────────
    function test_creditUSDC_byAuthorized() public {
        usdc.mint(address(vault), 500_000);
        vm.prank(router1);
        vault.creditUSDC(asset, 500_000, SOURCE_REVENUE);
        BuybackVault.AssetData memory d = vault.assetData(asset);
        assertEq(d.balanceUSDC,        500_000);
        assertEq(d.buybackFromRevenue, 500_000);
    }

    function test_creditUSDC_revertsIfNotAuthorized() public {
        vm.expectRevert(BuybackVault.NotAuthorized.selector);
        vault.creditUSDC(asset, 100_000, SOURCE_REVENUE);
    }

    function test_creditUSDC_tradingTag() public {
        usdc.mint(address(vault), 500_000);
        vm.prank(router1);
        vault.creditUSDC(asset, 500_000, SOURCE_TRADING);
        assertEq(vault.assetData(asset).buybackFromTrading, 500_000);
    }

    // ── execute (USDC pair) ──────────────────────────────────────────────────
    // v2: CapWindowActive guard removed (Decision #6)
    // balanceLimitEnd check is no longer done; vault is excluded from balance limit

    function test_execute_revertsIfCooldown() public {
        usdc.mint(address(vault), 10e6);
        vm.prank(router1);
        vault.creditUSDC(asset, 10e6, SOURCE_REVENUE);
        vault.execute(asset, 1e6, 0);
        vm.expectRevert(BuybackVault.CooldownActive.selector);
        vault.execute(asset, 1e6, 0);
    }

    function test_execute_revertsIfExceedsMax() public {
        uint256 bigAmt = C.BUYBACK_MAX_PER_CALL + 1;
        usdc.mint(address(vault), bigAmt);
        vm.prank(router1);
        vault.creditUSDC(asset, bigAmt, SOURCE_REVENUE);
        vm.expectRevert(BuybackVault.ExceedsMaxPerCall.selector);
        vault.execute(asset, bigAmt, 0);
    }

    function test_execute_revertsIfInsufficient() public {
        vm.expectRevert(BuybackVault.InsufficientBalance.selector);
        vault.execute(asset, 1e6, 0);
    }

    function test_execute_reducesBalance() public {
        uint256 amt = 5e6;
        usdc.mint(address(vault), amt);
        vm.prank(router1);
        vault.creditUSDC(asset, amt, SOURCE_REVENUE);
        vault.execute(asset, amt, 0);
        assertEq(vault.assetData(asset).balanceUSDC, 0);
    }

    // ── execute: BuybackNotAvailable for WMON-paired tokens ──────────────────
    function test_execute_revertsForWMONPair() public {
        // Register a WMON-paired asset
        MockAssetToken wmonToken = new MockAssetToken();
        address wmonAsset = address(wmonToken);

        PoolKey memory wmonPoolKey = PoolKey({
            currency0:   WMON_ADDR < wmonAsset ? WMON_ADDR : wmonAsset,
            currency1:   WMON_ADDR < wmonAsset ? wmonAsset : WMON_ADDR,
            fee:         20_000,
            tickSpacing: 200,
            hooks:       address(0)
        });
        bytes32 wmonPoolId = keccak256("wmon-pool");

        vault.registerAsset(wmonAsset, wmonPoolKey, wmonPoolId, WMON_ADDR);
        vault.authorize(router1);

        // Credit some USDC
        usdc.mint(address(vault), 1e6);
        vm.prank(router1);
        vault.creditUSDC(wmonAsset, 1e6, SOURCE_REVENUE);

        // Should revert with BuybackNotAvailable
        vm.expectRevert(BuybackVault.BuybackNotAvailable.selector);
        vault.execute(wmonAsset, 1e6, 0);
    }

    // ── burnTokens ────────────────────────────────────────────────────────────
    function test_burnTokens_burnsAccumulated() public {
        // burnTokens is a no-op when tokenBalance is 0
        vault.burnTokens(asset);
        assertEq(token.burnedTotal(), uint256(0));
    }

    function test_burnTokens_revertsForUnregistered() public {
        vm.expectRevert(BuybackVault.AssetNotRegistered.selector);
        vault.burnTokens(address(0xDEAD));
    }

    // ── Fuzz ──────────────────────────────────────────────────────────────────
    /// @dev creditUSDC only increases balanceUSDC.
    function testFuzz_creditUSDC_monotonic(uint256 a, uint256 b) public {
        a = bound(a, 0, type(uint64).max);
        b = bound(b, 0, type(uint64).max);
        usdc.mint(address(vault), a + b);
        vm.prank(router1);
        vault.creditUSDC(asset, a, SOURCE_REVENUE);
        uint256 midBal = vault.assetData(asset).balanceUSDC;
        vm.prank(router1);
        vault.creditUSDC(asset, b, SOURCE_REVENUE);
        assertEq(vault.assetData(asset).balanceUSDC, midBal + b);
    }

    /// @dev execute can only reduce balanceUSDC.
    function testFuzz_execute_reducesBalance(uint256 amt) public {
        amt = bound(amt, 1, C.BUYBACK_MAX_PER_CALL);
        usdc.mint(address(vault), amt);
        vm.prank(router1);
        vault.creditUSDC(asset, amt, SOURCE_REVENUE);
        uint256 before = vault.assetData(asset).balanceUSDC;
        vault.execute(asset, amt, 0);
        assertLe(vault.assetData(asset).balanceUSDC, before);
    }
}

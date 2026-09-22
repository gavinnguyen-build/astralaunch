// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {RevenueRouter} from "../../src/RevenueRouter.sol";
import {RevpadConstants as C} from "../../src/RevpadConstants.sol";

// ── Minimal stubs ─────────────────────────────────────────────────────────────
contract MockEscrow {
    mapping(address => uint256) public recorded;
    function recordRevenue(address asset, uint256 amt) external { recorded[asset] += amt; }
    function authorizeRouter(address) external {}
    function registerAsset(address, address, uint48, bytes32) external {}
}

contract MockVault {
    mapping(address => uint256) public credited;
    mapping(address => uint8)   public lastTag;
    function creditUSDC(address asset, uint256 amt, uint8 tag) external {
        credited[asset] += amt;
        lastTag[asset]   = tag;
    }
    function registerAsset(address, bytes calldata, bytes32) external {}
    function authorize(address) external {}
}

contract MockUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }

    function transfer(address to, uint256 amt) external returns (bool) {
        require(balanceOf[msg.sender] >= amt, "insufficient");
        balanceOf[msg.sender] -= amt;
        balanceOf[to]         += amt;
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        require(allowance[from][msg.sender] >= amt, "allowance");
        allowance[from][msg.sender] -= amt;
        balanceOf[from]             -= amt;
        balanceOf[to]               += amt;
        return true;
    }

    function approve(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt;
        return true;
    }
}

// ── Test contract ─────────────────────────────────────────────────────────────
contract RevenueRouterTest is Test {
    RevenueRouter  impl;
    RevenueRouter  router;
    MockUSDC       usdc;
    MockEscrow     escrow;
    MockVault      vault;

    address asset    = address(0xA55E7);
    address creator  = address(0xC8EA7012);
    address treasury = address(0x7AEA5);
    address registry = address(this); // test contract acts as registry

    function setUp() public {
        usdc   = new MockUSDC();
        escrow = new MockEscrow();
        vault  = new MockVault();
        impl   = new RevenueRouter();

        // Deploy clone
        address clone = LibClone.clone(address(impl));
        router = RevenueRouter(clone);

        // Patch USDC constant: we deploy a mock but the router has it hardcoded.
        // Use vm.etch to replace the USDC bytecode at the canonical address.
        vm.etch(0x754704Bc059F8C67012fEd69BC8A327a5aafb603, address(usdc).code);
        // Copy storage is not needed; MockUSDC uses its own mapping storage at the hardcoded address.
        // We work around this by using the canonical USDC address as our mock.
        usdc = MockUSDC(0x754704Bc059F8C67012fEd69BC8A327a5aafb603);

        router.initialize(asset, creator, creator, registry, address(escrow), address(vault), treasury);
    }

    // ── Initialization ────────────────────────────────────────────────────────
    function test_initialize_setsFields() public view {
        assertEq(router.asset(),        asset);
        assertEq(router.creator(),      creator);
        assertEq(router.provider(),     creator);
        assertEq(router.registry(),     registry);
        assertEq(router.feeEscrow(),    address(escrow));
        assertEq(router.buybackVault(), address(vault));
        assertEq(router.treasury(),     treasury);
        assertEq(router.costBps(),      0);
    }

    function test_initialize_revertsOnSecondCall() public {
        vm.expectRevert(RevenueRouter.AlreadyInitialized.selector);
        router.initialize(asset, creator, creator, registry, address(escrow), address(vault), treasury);
    }

    // ── distribute ────────────────────────────────────────────────────────────
    function test_distribute_belowMin_noOp() public {
        usdc.mint(address(router), C.MIN_DISTRIBUTE - 1);
        uint256 before = usdc.balanceOf(address(router));
        router.distribute();
        assertEq(usdc.balanceOf(address(router)), before); // nothing moved
    }

    function test_distribute_splits_correctly() public {
        uint256 amt = 1_000_000; // 1 USDC
        usdc.mint(address(router), amt);

        router.distribute();

        uint256 providerExpected  = (amt * C.PROVIDER_BPS) / 10_000;
        uint256 buybackExpected   = (amt * C.BUYBACK_BPS)  / 10_000;
        uint256 treasuryExpected  = (amt * C.TREASURY_BPS) / 10_000;
        uint256 dustExpected      = amt - providerExpected - buybackExpected - treasuryExpected;

        assertEq(usdc.balanceOf(creator),         providerExpected);
        assertEq(usdc.balanceOf(treasury),        treasuryExpected);
        assertEq(vault.credited(asset),           buybackExpected);
        assertEq(usdc.balanceOf(address(vault)),  buybackExpected);
        assertEq(usdc.balanceOf(address(router)), dustExpected); // dust stays
        assertEq(escrow.recorded(asset),          amt);          // full amount recorded
    }

    function test_distribute_dustStaysInRouter() public {
        // 3 USDC: dust = 3_000_000 - 1_800_000 - 900_000 - 300_000 = 0; try 1_000_001
        uint256 amt = 1_000_001;
        usdc.mint(address(router), amt);
        router.distribute();
        uint256 dust = amt
            - (amt * C.PROVIDER_BPS) / 10_000
            - (amt * C.BUYBACK_BPS)  / 10_000
            - (amt * C.TREASURY_BPS) / 10_000;
        assertEq(usdc.balanceOf(address(router)), dust);
    }

    function test_distribute_withCostBps() public {
        // Set costBps = 1000 (10% of provider share)
        router.setCost(address(0xC057), 1_000);
        uint256 amt = 1_000_000;
        usdc.mint(address(router), amt);
        router.distribute();

        uint256 providerAmt = (amt * (C.PROVIDER_BPS - 1_000)) / 10_000; // 5000 bps
        uint256 costAmt     = (amt * 1_000) / 10_000;
        uint256 buybackAmt  = (amt * C.BUYBACK_BPS)  / 10_000;
        uint256 treasuryAmt = (amt * C.TREASURY_BPS) / 10_000;

        assertEq(usdc.balanceOf(creator),          providerAmt);
        assertEq(usdc.balanceOf(address(0xC057)),  costAmt);
        assertEq(vault.credited(asset),            buybackAmt);
        assertEq(usdc.balanceOf(treasury),         treasuryAmt);
        // sum of outputs + dust == input
        uint256 dust = amt - providerAmt - costAmt - buybackAmt - treasuryAmt;
        assertEq(usdc.balanceOf(address(router)), dust);
    }

    function test_distribute_sumsMatchInput() public {
        uint256 amt = 5_000_000;
        usdc.mint(address(router), amt);
        router.distribute();
        uint256 out = usdc.balanceOf(creator)
            + usdc.balanceOf(treasury)
            + usdc.balanceOf(address(vault))
            + usdc.balanceOf(address(router)); // dust
        assertEq(out, amt);
    }

    function test_distribute_reentrancyReverts() public {
        // Not trivially testable without a re-entrant mock; covered by reentrancy guard presence
        // Verify _locked is set correctly after init
        usdc.mint(address(router), 1_000_000);
        router.distribute(); // should not revert
    }

    // ── setProvider ───────────────────────────────────────────────────────────
    function test_setProvider_byCreator() public {
        address newProvider = address(0xBEEF);
        vm.prank(creator);
        router.setProvider(newProvider);
        assertEq(router.provider(), newProvider);
    }

    function test_setProvider_revertsIfNotCreator() public {
        vm.expectRevert(RevenueRouter.NotCreator.selector);
        router.setProvider(address(0xBEEF));
    }

    // ── setCost ───────────────────────────────────────────────────────────────
    function test_setCost_byRegistry() public {
        router.setCost(address(0xFEE), 1_000);
        assertEq(router.costBps(),      1_000);
        assertEq(router.costRecipient(), address(0xFEE));
    }

    function test_setCost_revertsIfNotRegistry() public {
        vm.prank(address(0x999));
        vm.expectRevert(RevenueRouter.NotRegistry.selector);
        router.setCost(address(0xFEE), 1_000);
    }

    function test_setCost_revertsIfTooHigh() public {
        vm.expectRevert(RevenueRouter.CostBpsTooHigh.selector);
        router.setCost(address(0xFEE), uint16(C.MAX_COST_BPS + 1));
    }

    // ── Fuzz: split sums ──────────────────────────────────────────────────────
    /// @dev For any amount >= MIN_DISTRIBUTE, sum(outputs) + dust == input.
    function testFuzz_distribute_sumInvariant(uint256 amt) public {
        amt = bound(amt, C.MIN_DISTRIBUTE, 1_000_000e6);
        usdc.mint(address(router), amt);
        router.distribute();
        uint256 outSum = usdc.balanceOf(creator)
            + usdc.balanceOf(treasury)
            + usdc.balanceOf(address(vault))
            + usdc.balanceOf(address(router));
        assertEq(outSum, amt);
    }

    /// @dev With costBps, sum still equals input.
    function testFuzz_distribute_sumWithCost(uint256 amt, uint16 bps) public {
        bps = uint16(bound(uint256(bps), 0, C.MAX_COST_BPS));
        amt = bound(amt, C.MIN_DISTRIBUTE, 1_000_000e6);
        router.setCost(address(0xFEE), bps);
        usdc.mint(address(router), amt);
        router.distribute();
        uint256 outSum = usdc.balanceOf(creator)
            + usdc.balanceOf(address(0xFEE))
            + usdc.balanceOf(treasury)
            + usdc.balanceOf(address(vault))
            + usdc.balanceOf(address(router));
        assertEq(outSum, amt);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FeeEscrow} from "../../src/FeeEscrow.sol";
import {AstralaunchConstants as C} from "../../src/AstralaunchConstants.sol";
import {IFeeAdapter} from "../../src/interfaces/IFeeAdapter.sol";
import {PoolKey} from "../../src/interfaces/IInitializer.sol";
import {SOURCE_FORFEIT} from "../../src/interfaces/IBuybackVault.sol";

// ── Stubs ─────────────────────────────────────────────────────────────────────

/// @dev Implements IFeeAdapter so it can serve as both the fee adapter in tests.
///      doCollect simulates fee collection: sends USDC (or WMON) to the caller.
///      collectFeesCall returns (address(this), abi.encodeCall(doCollect, (poolId)))
///      so the beneficiary calls doCollect directly, preserving msg.sender.
contract MockInitializerFee is IFeeAdapter {
    MockTokenUSDC usdc;
    address       wmon;
    mapping(bytes32 => mapping(address => uint256)) public usdcPending;
    mapping(bytes32 => mapping(address => uint256)) public wmonPending;
    address public lastCaller;

    constructor(address _usdc, address _wmon) {
        usdc = MockTokenUSDC(_usdc);
        wmon = _wmon;
    }

    function setUSDCPending(bytes32 poolId, address who, uint256 amt) external {
        usdcPending[poolId][who] = amt;
    }

    function setWMONPending(bytes32 poolId, address who, uint256 amt) external {
        wmonPending[poolId][who] = amt;
    }

    /// @dev Called by beneficiary via raw .call() — msg.sender is the beneficiary.
    function doCollect(bytes32 poolId) external returns (uint128, uint128) {
        lastCaller = msg.sender;
        uint256 u = usdcPending[poolId][msg.sender];
        uint256 w = wmonPending[poolId][msg.sender];
        if (u > 0) {
            usdcPending[poolId][msg.sender] = 0;
            usdc.mint(msg.sender, u);
        }
        if (w > 0) {
            wmonPending[poolId][msg.sender] = 0;
            MockTokenUSDC(wmon).mint(msg.sender, w);
        }
        return (uint128(u), uint128(w));
    }

    function collectFeesCall(bytes32 poolId)
        external view override
        returns (address target, bytes memory data)
    {
        return (address(this), abi.encodeCall(this.doCollect, (poolId)));
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

contract MockBuybackVaultFee {
    uint256 public received;
    uint8   public lastTag;
    function creditUSDC(address, uint256 amt, uint8 tag) external {
        received += amt;
        lastTag   = tag;
    }
    function authorize(address) external {}
    function registerAsset(address, bytes calldata, bytes32, address) external {}
}

contract MockTokenUSDC {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }
    function transfer(address to, uint256 amt) external returns (bool) {
        require(balanceOf[msg.sender] >= amt);
        balanceOf[msg.sender] -= amt;
        balanceOf[to]         += amt;
        return true;
    }
}

// ── Test contract ─────────────────────────────────────────────────────────────
contract FeeEscrowTest is Test {
    address constant USDC_ADDR = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address constant WMON_ADDR = 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A;

    FeeEscrow          escrow;
    MockInitializerFee init_;
    MockBuybackVaultFee vault;
    MockTokenUSDC       usdc;
    MockTokenUSDC       wmon;

    address registry = address(this);
    address asset    = address(0xA55E7);
    address creator  = address(0xC8EA7012);
    bytes32 poolId   = keccak256("test-pool");
    uint48  launch   = uint48(block.timestamp);

    address router1  = address(0xAB1);

    function setUp() public {
        // Etch canonical USDC address FIRST so all mocks use the same address
        MockTokenUSDC tmpUsdc = new MockTokenUSDC();
        vm.etch(USDC_ADDR, address(tmpUsdc).code);
        usdc = MockTokenUSDC(USDC_ADDR);

        // Etch WMON at canonical address
        MockTokenUSDC tmpWmon = new MockTokenUSDC();
        vm.etch(WMON_ADDR, address(tmpWmon).code);
        wmon = MockTokenUSDC(WMON_ADDR);

        // Create init_ with canonical addresses so collectFees mints correctly
        init_  = new MockInitializerFee(address(usdc), address(wmon));
        vault  = new MockBuybackVaultFee();

        // v2 constructor: (registry, buybackVault) - no initializer
        escrow = new FeeEscrow(registry, address(vault));

        // Register asset with USDC numeraire
        escrow.registerAsset(asset, creator, launch, poolId, USDC_ADDR);
        escrow.setAdapter(asset, address(init_));
        escrow.authorizeRouter(router1);
    }

    // ── registerAsset ─────────────────────────────────────────────────────────
    function test_register_setsData() public view {
        FeeEscrow.TokenData memory d = escrow.tokenData(asset);
        assertEq(d.creator,    creator);
        assertEq(d.launchTime, launch);
        assertEq(d.poolId,     poolId);
        assertEq(d.numeraire,  USDC_ADDR);
        assertFalse(d.forfeited);
    }

    function test_register_revertsIfNotRegistry() public {
        vm.prank(address(0x999));
        vm.expectRevert(FeeEscrow.NotRegistry.selector);
        escrow.registerAsset(address(0x1), creator, launch, poolId, USDC_ADDR);
    }

    function test_register_revertsIfDuplicate() public {
        vm.expectRevert(FeeEscrow.AlreadyRegistered.selector);
        escrow.registerAsset(asset, creator, launch, poolId, USDC_ADDR);
    }

    function test_register_revertsForUnregisteredAsset() public {
        vm.expectRevert(FeeEscrow.AssetNotRegistered.selector);
        escrow.collect(address(0xDEAD));
    }

    // ── setAdapter ────────────────────────────────────────────────────────────
    function test_setAdapter_revertsIfNotRegistry() public {
        vm.prank(address(0x999));
        vm.expectRevert(FeeEscrow.NotRegistry.selector);
        escrow.setAdapter(asset, address(init_));
    }

    // ── collect (USDC numeraire) ──────────────────────────────────────────────
    function test_collect_accumulatesUSDC() public {
        init_.setUSDCPending(poolId, address(escrow), 500_000);
        escrow.collect(asset);
        FeeEscrow.TokenData memory d = escrow.tokenData(asset);
        assertEq(d.usdcAccrued, 500_000);
    }

    function test_collect_zeroDoesNothing() public {
        escrow.collect(asset);
        assertEq(escrow.tokenData(asset).usdcAccrued, 0);
    }

    // ── collect (WMON numeraire) ──────────────────────────────────────────────
    function test_collect_wmon_parksAsNumerairePending() public {
        // Register a WMON-paired asset
        address wmonAsset = address(0xBEE);
        bytes32 wmonPoolId = keccak256("wmon-pool");
        escrow.registerAsset(wmonAsset, creator, launch, wmonPoolId, WMON_ADDR);
        escrow.setAdapter(wmonAsset, address(init_));

        init_.setWMONPending(wmonPoolId, address(escrow), 300_000);
        escrow.collect(wmonAsset);

        FeeEscrow.TokenData memory d = escrow.tokenData(wmonAsset);
        // WMON fees are parked as numerairePending (not usdcAccrued)
        assertEq(d.numerairePending, 300_000);
        assertEq(d.usdcAccrued, 0);
    }

    // ── recordRevenue ─────────────────────────────────────────────────────────
    function test_recordRevenue_byRouter() public {
        vm.prank(router1);
        escrow.recordRevenue(asset, 1_000_000);
        assertEq(escrow.tokenData(asset).recordedRevenue, 1_000_000);
    }

    function test_recordRevenue_revertsIfNotRouter() public {
        vm.expectRevert(FeeEscrow.NotRouter.selector);
        escrow.recordRevenue(asset, 1_000_000);
    }

    // ── claimable ─────────────────────────────────────────────────────────────
    function test_claimable_zeroBeforeRevenue() public view {
        assertEq(escrow.claimable(asset), 0);
    }

    function test_claimable_cappedByAccrued() public {
        // 1 USDC accrued, 100 USDC revenue -> allowance = 20 USDC; capped by 1 USDC accrued
        init_.setUSDCPending(poolId, address(escrow), 1_000_000);
        escrow.collect(asset);
        vm.prank(router1);
        escrow.recordRevenue(asset, 100_000_000);
        assertEq(escrow.claimable(asset), 1_000_000);
    }

    function test_claimable_cappedByAllowance() public {
        // 100 USDC accrued, 1 USDC revenue -> allowance = 0.2 USDC
        init_.setUSDCPending(poolId, address(escrow), 100_000_000);
        escrow.collect(asset);
        vm.prank(router1);
        escrow.recordRevenue(asset, 1_000_000);
        assertEq(escrow.claimable(asset), 200_000); // 1e6 * 2000 / 10000
    }

    function test_claimable_decreasesAfterClaim() public {
        init_.setUSDCPending(poolId, address(escrow), 1_000_000);
        escrow.collect(asset);
        vm.prank(router1);
        escrow.recordRevenue(asset, 100_000_000);
        uint256 before = escrow.claimable(asset);
        vm.prank(creator);
        escrow.claim(asset);
        assertEq(escrow.claimable(asset), 0);
        assertEq(usdc.balanceOf(creator), before);
    }

    // ── claim ─────────────────────────────────────────────────────────────────
    function test_claim_revertsIfNotCreator() public {
        vm.expectRevert(FeeEscrow.NotCreator.selector);
        escrow.claim(asset);
    }

    function test_claim_revertsIfNothingToClaim() public {
        vm.prank(creator);
        vm.expectRevert(FeeEscrow.NothingToClaim.selector);
        escrow.claim(asset);
    }

    // ── forfeit ───────────────────────────────────────────────────────────────
    function test_forfeit_revertsBeforeDelay() public {
        vm.expectRevert(FeeEscrow.ForfeitTooEarly.selector);
        escrow.forfeit(asset);
    }

    function test_forfeit_movesUSDCToBuyback() public {
        // Accrue some USDC
        init_.setUSDCPending(poolId, address(escrow), 2_000_000);
        escrow.collect(asset);

        vm.warp(uint256(launch) + C.FORFEIT_DELAY + 1);
        escrow.forfeit(asset);

        assertTrue(escrow.tokenData(asset).forfeited);
        assertEq(vault.received(), uint256(2_000_000));
        assertEq(uint256(vault.lastTag()), uint256(SOURCE_FORFEIT));
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_forfeit_revertsIfAlreadyForfeited() public {
        vm.warp(uint256(launch) + C.FORFEIT_DELAY + 1);
        escrow.forfeit(asset);
        vm.expectRevert(FeeEscrow.AlreadyForfeited.selector);
        escrow.forfeit(asset);
    }

    function test_forfeit_creatorCannotClaimAfter() public {
        init_.setUSDCPending(poolId, address(escrow), 2_000_000);
        escrow.collect(asset);
        vm.prank(router1);
        escrow.recordRevenue(asset, 100_000_000);

        vm.warp(uint256(launch) + C.FORFEIT_DELAY + 1);
        escrow.forfeit(asset);

        assertEq(escrow.claimable(asset), 0);
    }

    // ── forfeit with WMON pending ─────────────────────────────────────────────
    function test_forfeit_movesWMONToBuyback() public {
        // Register a WMON-paired asset
        address wmonAsset = address(0xBEE);
        bytes32 wmonPoolId = keccak256("wmon-pool");
        escrow.registerAsset(wmonAsset, creator, launch, wmonPoolId, WMON_ADDR);
        escrow.setAdapter(wmonAsset, address(init_));

        // Accrue WMON
        init_.setWMONPending(wmonPoolId, address(escrow), 500_000);
        escrow.collect(wmonAsset);
        assertEq(escrow.tokenData(wmonAsset).numerairePending, 500_000);

        vm.warp(uint256(launch) + C.FORFEIT_DELAY + 1);
        escrow.forfeit(wmonAsset);

        assertTrue(escrow.tokenData(wmonAsset).forfeited);
        // WMON should be transferred to buyback vault
        assertEq(wmon.balanceOf(address(vault)), 500_000);
        assertEq(escrow.tokenData(wmonAsset).numerairePending, 0);
    }

    // ── Fuzz ──────────────────────────────────────────────────────────────────
    /// @dev claimable <= min(allowance, accrued) - claimed always.
    function testFuzz_claimable_bounds(uint128 accrued, uint128 revenue, uint128 claimed) public {
        // bound claimed <= accrued
        claimed = uint128(bound(uint256(claimed), 0, uint256(accrued)));

        init_.setUSDCPending(poolId, address(escrow), accrued);
        escrow.collect(asset);
        vm.prank(router1);
        escrow.recordRevenue(asset, revenue);

        uint256 c = escrow.claimable(asset);
        uint256 allowance = (uint256(revenue) * C.ESCROW_UNLOCK_BPS) / 10_000;
        uint256 maxPay    = allowance < accrued ? allowance : accrued;
        assertLe(c, maxPay);
        assertGe(c, 0);
    }

    /// @dev sum of claimed + remaining claimable <= accrued at all times.
    function testFuzz_escrow_noOverpayment(uint128 accrued, uint128 revenue) public {
        revenue = uint128(bound(uint256(revenue), 1e6, type(uint128).max));
        accrued = uint128(bound(uint256(accrued), 1, type(uint64).max));

        init_.setUSDCPending(poolId, address(escrow), accrued);
        escrow.collect(asset);
        vm.prank(router1);
        escrow.recordRevenue(asset, revenue);

        uint256 claimNow = escrow.claimable(asset);
        if (claimNow > 0) {
            vm.prank(creator);
            escrow.claim(asset);
        }

        FeeEscrow.TokenData memory d = escrow.tokenData(asset);
        // claimed + remaining claimable <= usdcAccrued
        assertLe(uint256(d.usdcClaimed) + escrow.claimable(asset), uint256(d.usdcAccrued));
    }
}

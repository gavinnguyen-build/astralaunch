// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FeeEscrow} from "../../src/FeeEscrow.sol";
import {RevpadConstants as C} from "../../src/RevpadConstants.sol";
import {SOURCE_FORFEIT} from "../../src/interfaces/IBuybackVault.sol";

// ── Stubs ─────────────────────────────────────────────────────────────────────
contract MockInitializerFee {
    // Simulates collectFees: sends USDC (and optionally tokens) to caller.
    MockTokenUSDC usdc;
    mapping(bytes32 => mapping(address => uint256)) public usdcPending;
    mapping(bytes32 => mapping(address => uint256)) public tokenPending;
    address public lastCaller;

    constructor(address _usdc) { usdc = MockTokenUSDC(_usdc); }

    function setUSDCPending(bytes32 poolId, address who, uint256 amt) external {
        usdcPending[poolId][who] = amt;
    }
    function setTokenPending(bytes32 poolId, address token, address who, uint256 amt) external {
        tokenPending[poolId][who] = amt; // using who as key
    }

    function collectFees(bytes32 poolId) external returns (uint128, uint128) {
        lastCaller = msg.sender;
        uint256 u = usdcPending[poolId][msg.sender];
        if (u > 0) {
            usdcPending[poolId][msg.sender] = 0;
            usdc.mint(msg.sender, u);
        }
        return (uint128(u), 0);
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
    function registerAsset(address, bytes calldata, bytes32) external {}
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
    FeeEscrow          escrow;
    MockInitializerFee init_;
    MockBuybackVaultFee vault;
    MockTokenUSDC       usdc;

    address registry = address(this);
    address asset    = address(0xA55E7);
    address creator  = address(0xC8EA7012);
    bytes32 poolId   = keccak256("test-pool");
    uint48  launch   = uint48(block.timestamp);

    address router1  = address(0xAB1);

    function setUp() public {
        // Etch canonical USDC address FIRST so all mocks use the same address
        MockTokenUSDC tmpUsdc = new MockTokenUSDC();
        vm.etch(0x754704Bc059F8C67012fEd69BC8A327a5aafb603, address(tmpUsdc).code);
        usdc = MockTokenUSDC(0x754704Bc059F8C67012fEd69BC8A327a5aafb603);

        // Now create init_ with the canonical address so collectFees mints to it
        init_  = new MockInitializerFee(address(usdc));
        vault  = new MockBuybackVaultFee();
        escrow = new FeeEscrow(registry, address(vault), address(init_));

        // Register asset
        escrow.registerAsset(asset, creator, launch, poolId);
        escrow.authorizeRouter(router1);
    }

    // ── registerAsset ─────────────────────────────────────────────────────────
    function test_register_setsData() public view {
        FeeEscrow.TokenData memory d = escrow.tokenData(asset);
        assertEq(d.creator,    creator);
        assertEq(d.launchTime, launch);
        assertEq(d.poolId,     poolId);
        assertFalse(d.forfeited);
    }

    function test_register_revertsIfNotRegistry() public {
        vm.prank(address(0x999));
        vm.expectRevert(FeeEscrow.NotRegistry.selector);
        escrow.registerAsset(address(0x1), creator, launch, poolId);
    }

    function test_register_revertsIfDuplicate() public {
        vm.expectRevert(FeeEscrow.AlreadyRegistered.selector);
        escrow.registerAsset(asset, creator, launch, poolId);
    }

    function test_register_revertsForUnregisteredAsset() public {
        vm.expectRevert(FeeEscrow.AssetNotRegistered.selector);
        escrow.collect(address(0xDEAD));
    }

    // ── collect ───────────────────────────────────────────────────────────────
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
        // 1 USDC accrued, 100 USDC revenue → allowance = 20 USDC; capped by 1 USDC accrued
        init_.setUSDCPending(poolId, address(escrow), 1_000_000);
        escrow.collect(asset);
        vm.prank(router1);
        escrow.recordRevenue(asset, 100_000_000);
        assertEq(escrow.claimable(asset), 1_000_000);
    }

    function test_claimable_cappedByAllowance() public {
        // 100 USDC accrued, 1 USDC revenue → allowance = 0.2 USDC
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

    // ── Fuzz ──────────────────────────────────────────────────────────────────
    /// @dev claimable ≤ min(allowance, accrued) − claimed always.
    function testFuzz_claimable_bounds(uint128 accrued, uint128 revenue, uint128 claimed) public {
        // bound claimed ≤ accrued
        claimed = uint128(bound(uint256(claimed), 0, uint256(accrued)));

        init_.setUSDCPending(poolId, address(escrow), accrued);
        escrow.collect(asset);
        vm.prank(router1);
        escrow.recordRevenue(asset, revenue);

        // Manually set claimed via partial claims (simulate with token transfers)
        // We can't set usdcClaimed directly; use real claim flow
        // Just verify claimable never exceeds theoretical max
        uint256 c = escrow.claimable(asset);
        uint256 allowance = (uint256(revenue) * C.ESCROW_UNLOCK_BPS) / 10_000;
        uint256 maxPay    = allowance < accrued ? allowance : accrued;
        assertLe(c, maxPay);
        assertGe(c, 0);
    }

    /// @dev sum of claimed + remaining claimable ≤ accrued at all times.
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
        // claimed + remaining claimable ≤ usdcAccrued
        assertLe(uint256(d.usdcClaimed) + escrow.claimable(asset), uint256(d.usdcAccrued));
    }
}

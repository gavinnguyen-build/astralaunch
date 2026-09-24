// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PlatformFeeReceiver} from "../../src/PlatformFeeReceiver.sol";
import {RevpadConstants as C} from "../../src/RevpadConstants.sol";

// ── Mocks ────────────────────────────────────────────────────────────────────

/// @dev Simulates the Doppler initializer's collectFees: deals USDC and tokens
///      to the caller (msg.sender = PlatformFeeReceiver) via vm.store-style mint.
contract MockInitializerPFR {
    address constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    // If a test wants collectFees to actually mint tokens, it can pre-fund the PFR.
    function collectFees(bytes32) external pure returns (uint128, uint128) {
        return (0, 0);
    }

    function getShares(bytes32, address) external pure returns (uint256) { return 0; }
}

contract MockUSDCPFR {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }

    function transfer(address to, uint256 amt) external returns (bool) {
        require(balanceOf[msg.sender] >= amt, "MockUSDC: insufficient");
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function approve(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt;
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        require(balanceOf[from] >= amt, "MockUSDC: insufficient");
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        return true;
    }
}

contract MockTokenPFR {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }

    function transfer(address to, uint256 amt) external returns (bool) {
        require(balanceOf[msg.sender] >= amt, "MockToken: insufficient");
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function totalSupply() external pure returns (uint256) { return 1e27; }
}

// ── Test contract ────────────────────────────────────────────────────────────

contract PlatformFeeReceiverTest is Test {
    address constant USDC_ADDR = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;

    PlatformFeeReceiver pfr;
    MockInitializerPFR  init_;
    MockUSDCPFR         usdc;
    MockTokenPFR        token;

    address registryAddr = address(0xABCD);
    address admin        = address(0xAD);
    address treasury     = address(0x7AEA5);
    address asset;
    bytes32 poolId       = keccak256("test-pool");

    function setUp() public {
        init_ = new MockInitializerPFR();
        token = new MockTokenPFR();
        asset = address(token);

        // Etch mock USDC at the canonical address
        usdc = new MockUSDCPFR();
        vm.etch(USDC_ADDR, address(usdc).code);
        usdc = MockUSDCPFR(USDC_ADDR);

        pfr = new PlatformFeeReceiver(registryAddr, address(init_), treasury, admin);
    }

    // ── Constructor ─────────────────────────────────────────────────────────────

    function test_constructor_setsState() public view {
        assertEq(pfr.registry(), registryAddr);
        assertEq(address(pfr.initializer()), address(init_));
        assertEq(pfr.treasury(), treasury);
        assertEq(pfr.admin(), admin);
    }

    function test_constructor_revertsZeroRegistry() public {
        vm.expectRevert(PlatformFeeReceiver.ZeroAddress.selector);
        new PlatformFeeReceiver(address(0), address(init_), treasury, admin);
    }

    function test_constructor_revertsZeroInitializer() public {
        vm.expectRevert(PlatformFeeReceiver.ZeroAddress.selector);
        new PlatformFeeReceiver(registryAddr, address(0), treasury, admin);
    }

    function test_constructor_revertsZeroTreasury() public {
        vm.expectRevert(PlatformFeeReceiver.ZeroAddress.selector);
        new PlatformFeeReceiver(registryAddr, address(init_), address(0), admin);
    }

    function test_constructor_revertsZeroAdmin() public {
        vm.expectRevert(PlatformFeeReceiver.ZeroAddress.selector);
        new PlatformFeeReceiver(registryAddr, address(init_), treasury, address(0));
    }

    // ── registerAsset ───────────────────────────────────────────────────────────

    function test_registerAsset_setsPoolId() public {
        vm.prank(registryAddr);
        pfr.registerAsset(asset, poolId);
        assertEq(pfr.assetPoolIds(asset), poolId);
    }

    function test_registerAsset_emitsEvent() public {
        vm.prank(registryAddr);
        vm.expectEmit(true, true, false, false);
        emit PlatformFeeReceiver.AssetRegistered(asset, poolId);
        pfr.registerAsset(asset, poolId);
    }

    function test_registerAsset_revertsIfNotRegistry() public {
        vm.expectRevert(PlatformFeeReceiver.NotRegistry.selector);
        pfr.registerAsset(asset, poolId);
    }

    // ── collect ─────────────────────────────────────────────────────────────────

    function test_collect_forwardsUSDC() public {
        // Register asset
        vm.prank(registryAddr);
        pfr.registerAsset(asset, poolId);

        // Seed PFR with USDC
        uint256 usdcAmt = 1_000_000; // 1 USDC
        usdc.mint(address(pfr), usdcAmt);

        uint256 treasuryBefore = usdc.balanceOf(treasury);
        pfr.collect(asset);
        assertEq(usdc.balanceOf(treasury) - treasuryBefore, usdcAmt, "USDC forwarded");
        assertEq(usdc.balanceOf(address(pfr)), 0, "PFR drained");
    }

    function test_collect_forwardsTokens() public {
        vm.prank(registryAddr);
        pfr.registerAsset(asset, poolId);

        uint256 tokenAmt = 1e18;
        token.mint(address(pfr), tokenAmt);

        pfr.collect(asset);
        assertEq(token.balanceOf(treasury), tokenAmt, "tokens forwarded");
        assertEq(token.balanceOf(address(pfr)), 0, "PFR drained");
    }

    function test_collect_forwardsBoth() public {
        vm.prank(registryAddr);
        pfr.registerAsset(asset, poolId);

        usdc.mint(address(pfr), 500_000);
        token.mint(address(pfr), 2e18);

        pfr.collect(asset);
        assertEq(usdc.balanceOf(treasury), 500_000);
        assertEq(token.balanceOf(treasury), 2e18);
    }

    function test_collect_emitsEvent() public {
        vm.prank(registryAddr);
        pfr.registerAsset(asset, poolId);

        usdc.mint(address(pfr), 100_000);
        token.mint(address(pfr), 1e18);

        vm.expectEmit(true, false, false, true);
        emit PlatformFeeReceiver.Collected(asset, 100_000, 1e18);
        pfr.collect(asset);
    }

    function test_collect_revertsIfNotRegistered() public {
        vm.expectRevert(PlatformFeeReceiver.AssetNotRegistered.selector);
        pfr.collect(asset);
    }

    function test_collect_noopOnZeroBalance() public {
        vm.prank(registryAddr);
        pfr.registerAsset(asset, poolId);

        // Should not revert, just emit zero amounts
        pfr.collect(asset);
    }

    // ── proposeTreasury ─────────────────────────────────────────────────────────

    function test_proposeTreasury_setsProposal() public {
        address newT = address(0xBEEF);
        vm.prank(admin);
        pfr.proposeTreasury(newT);

        (address proposed, uint256 execAt) = pfr.pendingTreasury();
        assertEq(proposed, newT);
        assertEq(execAt, block.timestamp + C.TREASURY_CHANGE_DELAY);
    }

    function test_proposeTreasury_emitsEvent() public {
        address newT = address(0xBEEF);
        vm.prank(admin);
        vm.expectEmit(true, false, false, true);
        emit PlatformFeeReceiver.TreasuryProposed(newT, block.timestamp + C.TREASURY_CHANGE_DELAY);
        pfr.proposeTreasury(newT);
    }

    function test_proposeTreasury_revertsIfNotAdmin() public {
        vm.expectRevert(PlatformFeeReceiver.NotAdmin.selector);
        pfr.proposeTreasury(address(0xBEEF));
    }

    function test_proposeTreasury_revertsZeroAddress() public {
        vm.prank(admin);
        vm.expectRevert(PlatformFeeReceiver.ZeroAddress.selector);
        pfr.proposeTreasury(address(0));
    }

    function test_proposeTreasury_revertsIfAlreadyActive() public {
        vm.prank(admin);
        pfr.proposeTreasury(address(0xBEEF));
        vm.prank(admin);
        vm.expectRevert(PlatformFeeReceiver.ProposalAlreadyActive.selector);
        pfr.proposeTreasury(address(0xCAFE));
    }

    // ── acceptTreasury ──────────────────────────────────────────────────────────

    function test_acceptTreasury_updatesAfterDelay() public {
        address newT = address(0xBEEF);
        vm.prank(admin);
        pfr.proposeTreasury(newT);

        vm.warp(block.timestamp + C.TREASURY_CHANGE_DELAY);
        vm.prank(admin);
        pfr.acceptTreasury();

        assertEq(pfr.treasury(), newT);
        (address proposed,) = pfr.pendingTreasury();
        assertEq(proposed, address(0), "proposal cleared");
    }

    function test_acceptTreasury_emitsEvent() public {
        address newT = address(0xBEEF);
        vm.prank(admin);
        pfr.proposeTreasury(newT);
        vm.warp(block.timestamp + C.TREASURY_CHANGE_DELAY);

        vm.prank(admin);
        vm.expectEmit(true, true, false, false);
        emit PlatformFeeReceiver.TreasuryAccepted(treasury, newT);
        pfr.acceptTreasury();
    }

    function test_acceptTreasury_revertsIfNoProposal() public {
        vm.prank(admin);
        vm.expectRevert(PlatformFeeReceiver.NoActiveProposal.selector);
        pfr.acceptTreasury();
    }

    function test_acceptTreasury_revertsIfNotAdmin() public {
        vm.prank(admin);
        pfr.proposeTreasury(address(0xBEEF));
        vm.warp(block.timestamp + C.TREASURY_CHANGE_DELAY);

        vm.expectRevert(PlatformFeeReceiver.NotAdmin.selector);
        pfr.acceptTreasury();
    }

    function test_acceptTreasury_revertsBeforeDelay() public {
        vm.prank(admin);
        pfr.proposeTreasury(address(0xBEEF));
        vm.warp(block.timestamp + C.TREASURY_CHANGE_DELAY - 1);

        vm.prank(admin);
        vm.expectRevert(PlatformFeeReceiver.ProposalNotReady.selector);
        pfr.acceptTreasury();
    }

    // ── cancelProposal ──────────────────────────────────────────────────────────

    function test_cancelProposal_clearsState() public {
        vm.prank(admin);
        pfr.proposeTreasury(address(0xBEEF));

        vm.prank(admin);
        pfr.cancelProposal();

        (address proposed,) = pfr.pendingTreasury();
        assertEq(proposed, address(0));
        assertEq(pfr.treasury(), treasury, "treasury unchanged");
    }

    function test_cancelProposal_emitsEvent() public {
        address newT = address(0xBEEF);
        vm.prank(admin);
        pfr.proposeTreasury(newT);

        vm.prank(admin);
        vm.expectEmit(true, false, false, false);
        emit PlatformFeeReceiver.TreasuryProposalCancelled(newT);
        pfr.cancelProposal();
    }

    function test_cancelProposal_revertsIfNoProposal() public {
        vm.prank(admin);
        vm.expectRevert(PlatformFeeReceiver.NoActiveProposal.selector);
        pfr.cancelProposal();
    }

    function test_cancelProposal_revertsIfNotAdmin() public {
        vm.prank(admin);
        pfr.proposeTreasury(address(0xBEEF));

        vm.expectRevert(PlatformFeeReceiver.NotAdmin.selector);
        pfr.cancelProposal();
    }

    // ── pendingTreasury ─────────────────────────────────────────────────────────

    function test_pendingTreasury_returnsZeroWhenNone() public view {
        (address proposed, uint256 execAt) = pfr.pendingTreasury();
        assertEq(proposed, address(0));
        assertEq(execAt, 0);
    }

    // ── Full round trip ─────────────────────────────────────────────────────────

    function test_fullRoundTrip_treasuryChange() public {
        // Register asset and seed USDC
        vm.prank(registryAddr);
        pfr.registerAsset(asset, poolId);

        // Propose new treasury
        address newT = address(0xBEEF);
        vm.prank(admin);
        pfr.proposeTreasury(newT);

        // Warp past delay
        vm.warp(block.timestamp + C.TREASURY_CHANGE_DELAY);

        // Accept
        vm.prank(admin);
        pfr.acceptTreasury();
        assertEq(pfr.treasury(), newT);

        // Seed and collect — funds should go to NEW treasury
        usdc.mint(address(pfr), 5_000_000);
        token.mint(address(pfr), 3e18);

        pfr.collect(asset);
        assertEq(usdc.balanceOf(newT), 5_000_000, "USDC to new treasury");
        assertEq(token.balanceOf(newT), 3e18, "tokens to new treasury");
        assertEq(usdc.balanceOf(treasury), 0, "old treasury got nothing");
    }

    // ── Fuzz: exact forwarding amounts ──────────────────────────────────────────

    function testFuzz_collect_exactForwarding(uint128 usdcAmt, uint128 tokenAmt) public {
        vm.prank(registryAddr);
        pfr.registerAsset(asset, poolId);

        usdc.mint(address(pfr), usdcAmt);
        token.mint(address(pfr), tokenAmt);

        pfr.collect(asset);
        assertEq(usdc.balanceOf(treasury), usdcAmt, "USDC exact");
        assertEq(token.balanceOf(treasury), tokenAmt, "token exact");
    }

    // ── transferAdmin ─────────────────────────────────────────────────────────

    function test_transferAdmin_setsPendingAdmin() public {
        address newAdmin = address(0xCAFE);
        vm.prank(admin);
        pfr.transferAdmin(newAdmin);
        assertEq(pfr.pendingAdmin(), newAdmin);
    }

    function test_transferAdmin_emitsEvent() public {
        address newAdmin = address(0xCAFE);
        vm.prank(admin);
        vm.expectEmit(true, true, false, false);
        emit PlatformFeeReceiver.AdminTransferStarted(admin, newAdmin);
        pfr.transferAdmin(newAdmin);
    }

    function test_transferAdmin_revertsIfNotAdmin() public {
        vm.expectRevert(PlatformFeeReceiver.NotAdmin.selector);
        pfr.transferAdmin(address(0xCAFE));
    }

    function test_transferAdmin_revertsZeroAddress() public {
        vm.prank(admin);
        vm.expectRevert(PlatformFeeReceiver.ZeroAddress.selector);
        pfr.transferAdmin(address(0));
    }

    // ── acceptAdmin ──────────────────────────────────────────────────────────

    function test_acceptAdmin_updateAdmin() public {
        address newAdmin = address(0xCAFE);
        vm.prank(admin);
        pfr.transferAdmin(newAdmin);

        vm.prank(newAdmin);
        pfr.acceptAdmin();
        assertEq(pfr.admin(), newAdmin);
        assertEq(pfr.pendingAdmin(), address(0));
    }

    function test_acceptAdmin_emitsEvent() public {
        address newAdmin = address(0xCAFE);
        vm.prank(admin);
        pfr.transferAdmin(newAdmin);

        vm.prank(newAdmin);
        vm.expectEmit(true, true, false, false);
        emit PlatformFeeReceiver.AdminTransferred(admin, newAdmin);
        pfr.acceptAdmin();
    }

    function test_acceptAdmin_revertsIfNotPendingAdmin() public {
        vm.prank(admin);
        pfr.transferAdmin(address(0xCAFE));

        vm.prank(admin); // admin is NOT pendingAdmin
        vm.expectRevert(PlatformFeeReceiver.NotPendingAdmin.selector);
        pfr.acceptAdmin();
    }

    function test_acceptAdmin_revertsIfNoPending() public {
        vm.expectRevert(PlatformFeeReceiver.NotPendingAdmin.selector);
        pfr.acceptAdmin();
    }

    // ── cancelAdminTransfer ──────────────────────────────────────────────────

    function test_cancelAdminTransfer_clearsState() public {
        vm.prank(admin);
        pfr.transferAdmin(address(0xCAFE));

        vm.prank(admin);
        pfr.cancelAdminTransfer();
        assertEq(pfr.pendingAdmin(), address(0));
    }

    function test_cancelAdminTransfer_emitsEvent() public {
        address newAdmin = address(0xCAFE);
        vm.prank(admin);
        pfr.transferAdmin(newAdmin);

        vm.prank(admin);
        vm.expectEmit(true, false, false, false);
        emit PlatformFeeReceiver.AdminTransferCancelled(newAdmin);
        pfr.cancelAdminTransfer();
    }

    function test_cancelAdminTransfer_revertsIfNoTransfer() public {
        vm.prank(admin);
        vm.expectRevert(PlatformFeeReceiver.NoActiveTransfer.selector);
        pfr.cancelAdminTransfer();
    }

    function test_cancelAdminTransfer_revertsIfNotAdmin() public {
        vm.prank(admin);
        pfr.transferAdmin(address(0xCAFE));

        vm.expectRevert(PlatformFeeReceiver.NotAdmin.selector);
        pfr.cancelAdminTransfer();
    }

    // ── Old admin loses rights after transfer ────────────────────────────────

    function test_oldAdminLosesAllRights() public {
        address newAdmin = address(0xCAFE);
        vm.prank(admin);
        pfr.transferAdmin(newAdmin);
        vm.prank(newAdmin);
        pfr.acceptAdmin();

        // Old admin cannot propose treasury
        vm.prank(admin);
        vm.expectRevert(PlatformFeeReceiver.NotAdmin.selector);
        pfr.proposeTreasury(address(0xBEEF));

        // Old admin cannot transfer admin again
        vm.prank(admin);
        vm.expectRevert(PlatformFeeReceiver.NotAdmin.selector);
        pfr.transferAdmin(address(0xDEAD));

        // New admin CAN propose treasury
        vm.prank(newAdmin);
        pfr.proposeTreasury(address(0xBEEF));
    }

    // ── Fuzz ─────────────────────────────────────────────────────────────────

    function testFuzz_acceptTreasury_delayEnforcement(uint24 warpDelta) public {
        vm.prank(admin);
        pfr.proposeTreasury(address(0xBEEF));

        uint256 execAt = block.timestamp + C.TREASURY_CHANGE_DELAY;

        if (uint256(warpDelta) < C.TREASURY_CHANGE_DELAY) {
            vm.warp(block.timestamp + warpDelta);
            vm.prank(admin);
            vm.expectRevert(PlatformFeeReceiver.ProposalNotReady.selector);
            pfr.acceptTreasury();
        } else {
            vm.warp(execAt);
            vm.prank(admin);
            pfr.acceptTreasury();
            assertEq(pfr.treasury(), address(0xBEEF));
        }
    }
}

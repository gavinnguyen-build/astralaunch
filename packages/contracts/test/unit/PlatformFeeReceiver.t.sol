// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PlatformFeeReceiver} from "../../src/PlatformFeeReceiver.sol";
import {AstralaunchConstants as C} from "../../src/AstralaunchConstants.sol";
import {IFeeAdapter} from "../../src/interfaces/IFeeAdapter.sol";
import {PoolKey} from "../../src/interfaces/IInitializer.sol";

// ── Mocks ────────────────────────────────────────────────────────────────────

/// @dev Implements IFeeAdapter so it can serve as the fee adapter in tests.
///      doCollect is a no-op. collectFeesCall returns calldata for doCollect.
contract MockInitializerPFR is IFeeAdapter {
    address constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;

    function doCollect(bytes32) external pure returns (uint128, uint128) {
        return (0, 0);
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

contract MockWMONPFR {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }

    function transfer(address to, uint256 amt) external returns (bool) {
        require(balanceOf[msg.sender] >= amt, "MockWMON: insufficient");
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }
}

// ── Test contract ────────────────────────────────────────────────────────────

contract PlatformFeeReceiverTest is Test {
    address constant USDC_ADDR = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address constant WMON_ADDR = 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A;

    PlatformFeeReceiver pfr;
    MockInitializerPFR  init_;
    MockUSDCPFR         usdc;
    MockTokenPFR        token;
    MockWMONPFR         wmon;

    address registryAddr = address(0xABCD);
    address admin        = address(0xAD);
    address guardian     = address(0x6A12D);
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

        // Etch WMON at canonical address
        wmon = new MockWMONPFR();
        vm.etch(WMON_ADDR, address(wmon).code);
        wmon = MockWMONPFR(WMON_ADDR);

        // v2 constructor: (registry, treasury, admin, guardian) - no initializer
        pfr = new PlatformFeeReceiver(registryAddr, treasury, admin, guardian);
    }

    // ── Constructor ─────────────────────────────────────────────────────────────

    function test_constructor_setsState() public view {
        assertEq(pfr.registry(), registryAddr);
        assertEq(pfr.treasury(), treasury);
        assertEq(pfr.admin(), admin);
        assertEq(pfr.guardian(), guardian);
    }

    function test_constructor_revertsZeroRegistry() public {
        vm.expectRevert(PlatformFeeReceiver.ZeroAddress.selector);
        new PlatformFeeReceiver(address(0), treasury, admin, guardian);
    }

    function test_constructor_revertsZeroTreasury() public {
        vm.expectRevert(PlatformFeeReceiver.ZeroAddress.selector);
        new PlatformFeeReceiver(registryAddr, address(0), admin, guardian);
    }

    function test_constructor_revertsZeroAdmin() public {
        vm.expectRevert(PlatformFeeReceiver.ZeroAddress.selector);
        new PlatformFeeReceiver(registryAddr, treasury, address(0), guardian);
    }

    function test_constructor_revertsZeroGuardian() public {
        vm.expectRevert(PlatformFeeReceiver.ZeroAddress.selector);
        new PlatformFeeReceiver(registryAddr, treasury, admin, address(0));
    }

    // ── registerAsset ───────────────────────────────────────────────────────────

    function test_registerAsset_setsPoolIdAndNumeraire() public {
        vm.prank(registryAddr);
        pfr.registerAsset(asset, poolId, USDC_ADDR);
        assertEq(pfr.assetPoolIds(asset), poolId);
        assertEq(pfr.assetNumeraires(asset), USDC_ADDR);
    }

    function test_registerAsset_emitsEvent() public {
        vm.prank(registryAddr);
        vm.expectEmit(true, true, false, true);
        emit PlatformFeeReceiver.AssetRegistered(asset, poolId, USDC_ADDR);
        pfr.registerAsset(asset, poolId, USDC_ADDR);
    }

    function test_registerAsset_revertsIfNotRegistry() public {
        vm.expectRevert(PlatformFeeReceiver.NotRegistry.selector);
        pfr.registerAsset(asset, poolId, USDC_ADDR);
    }

    // ── setAdapter ────────────────────────────────────────────────────────────
    function test_setAdapter_byRegistry() public {
        vm.prank(registryAddr);
        pfr.setAdapter(asset, address(init_));
        // No revert means success
    }

    function test_setAdapter_revertsIfNotRegistry() public {
        vm.expectRevert(PlatformFeeReceiver.NotRegistry.selector);
        pfr.setAdapter(asset, address(init_));
    }

    // ── collect (USDC numeraire) ───────────────────────────────────────────────

    function test_collect_forwardsUSDC() public {
        vm.prank(registryAddr);
        pfr.registerAsset(asset, poolId, USDC_ADDR);
        vm.prank(registryAddr);
        pfr.setAdapter(asset, address(init_));

        uint256 usdcAmt = 1_000_000; // 1 USDC
        usdc.mint(address(pfr), usdcAmt);

        uint256 treasuryBefore = usdc.balanceOf(treasury);
        pfr.collect(asset);
        assertEq(usdc.balanceOf(treasury) - treasuryBefore, usdcAmt, "USDC forwarded");
        assertEq(usdc.balanceOf(address(pfr)), 0, "PFR drained");
    }

    function test_collect_forwardsTokens() public {
        vm.prank(registryAddr);
        pfr.registerAsset(asset, poolId, USDC_ADDR);
        vm.prank(registryAddr);
        pfr.setAdapter(asset, address(init_));

        uint256 tokenAmt = 1e18;
        token.mint(address(pfr), tokenAmt);

        pfr.collect(asset);
        assertEq(token.balanceOf(treasury), tokenAmt, "tokens forwarded");
        assertEq(token.balanceOf(address(pfr)), 0, "PFR drained");
    }

    function test_collect_forwardsBoth() public {
        vm.prank(registryAddr);
        pfr.registerAsset(asset, poolId, USDC_ADDR);
        vm.prank(registryAddr);
        pfr.setAdapter(asset, address(init_));

        usdc.mint(address(pfr), 500_000);
        token.mint(address(pfr), 2e18);

        pfr.collect(asset);
        assertEq(usdc.balanceOf(treasury), 500_000);
        assertEq(token.balanceOf(treasury), 2e18);
    }

    function test_collect_emitsEvent() public {
        vm.prank(registryAddr);
        pfr.registerAsset(asset, poolId, USDC_ADDR);
        vm.prank(registryAddr);
        pfr.setAdapter(asset, address(init_));

        usdc.mint(address(pfr), 100_000);
        token.mint(address(pfr), 1e18);

        vm.expectEmit(true, false, false, true);
        // v2 Collected event has 3 amount fields: usdcForwarded, tokenForwarded, numeraireForwarded
        emit PlatformFeeReceiver.Collected(asset, 100_000, 1e18, 0);
        pfr.collect(asset);
    }

    function test_collect_revertsIfNotRegistered() public {
        vm.expectRevert(PlatformFeeReceiver.AssetNotRegistered.selector);
        pfr.collect(asset);
    }

    function test_collect_noopOnZeroBalance() public {
        vm.prank(registryAddr);
        pfr.registerAsset(asset, poolId, USDC_ADDR);
        vm.prank(registryAddr);
        pfr.setAdapter(asset, address(init_));

        // Should not revert, just emit zero amounts
        pfr.collect(asset);
    }

    // ── collect (WMON numeraire) ──────────────────────────────────────────────
    function test_collect_forwardsWMONForWMONPair() public {
        vm.prank(registryAddr);
        pfr.registerAsset(asset, poolId, WMON_ADDR);
        vm.prank(registryAddr);
        pfr.setAdapter(asset, address(init_));

        wmon.mint(address(pfr), 1_000_000);

        pfr.collect(asset);
        assertEq(wmon.balanceOf(treasury), 1_000_000, "WMON forwarded to treasury");
        assertEq(wmon.balanceOf(address(pfr)), 0, "PFR drained of WMON");
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

    // ── cancelProposal: admin or guardian can cancel ────────────────────────────

    function test_cancelProposal_byAdmin_clearsState() public {
        vm.prank(admin);
        pfr.proposeTreasury(address(0xBEEF));

        vm.prank(admin);
        pfr.cancelProposal();

        (address proposed,) = pfr.pendingTreasury();
        assertEq(proposed, address(0));
        assertEq(pfr.treasury(), treasury, "treasury unchanged");
    }

    function test_cancelProposal_byGuardian_clearsState() public {
        vm.prank(admin);
        pfr.proposeTreasury(address(0xBEEF));

        vm.prank(guardian);
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

    function test_cancelProposal_revertsIfNotAdminOrGuardian() public {
        vm.prank(admin);
        pfr.proposeTreasury(address(0xBEEF));

        vm.expectRevert(PlatformFeeReceiver.NotAdminOrGuardian.selector);
        pfr.cancelProposal();
    }

    function test_guardian_cannotProposeTreasury() public {
        vm.prank(guardian);
        vm.expectRevert(PlatformFeeReceiver.NotAdmin.selector);
        pfr.proposeTreasury(address(0xBEEF));
    }

    function test_guardian_cannotAcceptTreasury() public {
        vm.prank(admin);
        pfr.proposeTreasury(address(0xBEEF));
        vm.warp(block.timestamp + C.TREASURY_CHANGE_DELAY);

        vm.prank(guardian);
        vm.expectRevert(PlatformFeeReceiver.NotAdmin.selector);
        pfr.acceptTreasury();
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
        pfr.registerAsset(asset, poolId, USDC_ADDR);
        vm.prank(registryAddr);
        pfr.setAdapter(asset, address(init_));

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

        // Seed and collect -- funds should go to NEW treasury
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
        pfr.registerAsset(asset, poolId, USDC_ADDR);
        vm.prank(registryAddr);
        pfr.setAdapter(asset, address(init_));

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

    // ── cancelAdminTransfer: admin or guardian can cancel ──────────────────────

    function test_cancelAdminTransfer_byAdmin_clearsState() public {
        vm.prank(admin);
        pfr.transferAdmin(address(0xCAFE));

        vm.prank(admin);
        pfr.cancelAdminTransfer();
        assertEq(pfr.pendingAdmin(), address(0));
    }

    function test_cancelAdminTransfer_byGuardian_clearsState() public {
        vm.prank(admin);
        pfr.transferAdmin(address(0xCAFE));

        vm.prank(guardian);
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

    function test_cancelAdminTransfer_revertsIfNotAdminOrGuardian() public {
        vm.prank(admin);
        pfr.transferAdmin(address(0xCAFE));

        vm.expectRevert(PlatformFeeReceiver.NotAdminOrGuardian.selector);
        pfr.cancelAdminTransfer();
    }

    function test_guardian_cannotTransferAdmin() public {
        vm.prank(guardian);
        vm.expectRevert(PlatformFeeReceiver.NotAdmin.selector);
        pfr.transferAdmin(address(0xCAFE));
    }

    function test_guardian_cannotAcceptAdmin() public {
        vm.prank(admin);
        pfr.transferAdmin(address(0xCAFE));

        vm.prank(guardian);
        vm.expectRevert(PlatformFeeReceiver.NotPendingAdmin.selector);
        pfr.acceptAdmin();
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

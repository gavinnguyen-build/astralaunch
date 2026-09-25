// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LaunchHelper, CreateParams} from "../../src/LaunchHelper.sol";

// ── Mocks ─────────────────────────────────────────────────────────────────────

contract MockAirlock {
    address public nextAsset = address(0xA55E7);
    bytes32 public lastSalt;
    address public lastCaller;
    bool public shouldRevert;

    function setRevert(bool r) external {
        shouldRevert = r;
    }

    function create(CreateParams calldata p) external returns (address, address, address, address, address) {
        require(!shouldRevert, "airlock: create failed");
        lastSalt = p.salt;
        lastCaller = msg.sender;
        return (nextAsset, nextAsset, address(0xdead), address(0), address(0));
    }
}

contract MockRegistry {
    address public constant ROUTER = address(0x7007E7);
    address public lastAsset;
    address public lastCreator;
    bool public shouldRevert;

    error WrongCreatorShare(uint256 got, uint256 expected);

    function setRevert(bool r) external {
        shouldRevert = r;
    }

    function register(address asset, address creator) external returns (address) {
        if (shouldRevert) revert WrongCreatorShare(0, 0.35e18);
        lastAsset = asset;
        lastCreator = creator;
        return ROUTER;
    }
}

contract RejectingTreasury {
    receive() external payable {
        revert("no MON");
    }
}

/// @dev Tries to re-enter launch() when it receives the fee.
contract ReentrantTreasury {
    LaunchHelper public helper;
    bool public reentered;
    bytes public reentryError;

    function setHelper(LaunchHelper h) external {
        helper = h;
    }

    receive() external payable {
        CreateParams memory p;
        try helper.launch{value: 0}(p, address(this)) {
            reentered = true;
        } catch (bytes memory err) {
            reentryError = err;
        }
    }
}

contract LaunchHelperTest is Test {
    MockAirlock airlock;
    MockRegistry registry;
    LaunchHelper helper;

    address constant TREASURY = address(0x888F);
    address constant CREATOR = address(0xC0FFEE);
    address constant LAUNCHER = address(0x1A0C);
    uint256 constant FEE = 10 ether;

    event LaunchFeePaid(address indexed launcher, address indexed asset, uint256 amount);
    event Launched(address indexed launcher, address indexed asset, address indexed creator, address router);

    function setUp() public {
        airlock = new MockAirlock();
        registry = new MockRegistry();
        helper = new LaunchHelper(address(airlock), address(registry), TREASURY, FEE);
        vm.deal(LAUNCHER, 1_000 ether);
    }

    function _params() internal pure returns (CreateParams memory p) {
        p.initialSupply = 1e27;
        p.numTokensToSell = 85e25;
        p.salt = keccak256("salt");
    }

    // ── Constructor ──────────────────────────────────────────────────────────

    function test_constructor_setsImmutables() public view {
        assertEq(address(helper.airlock()), address(airlock));
        assertEq(address(helper.registry()), address(registry));
        assertEq(helper.treasury(), TREASURY);
        assertEq(helper.launchFee(), FEE);
    }

    function test_constructor_revertsOnZeroAirlock() public {
        vm.expectRevert(LaunchHelper.ZeroAddress.selector);
        new LaunchHelper(address(0), address(registry), TREASURY, FEE);
    }

    function test_constructor_revertsOnZeroRegistry() public {
        vm.expectRevert(LaunchHelper.ZeroAddress.selector);
        new LaunchHelper(address(airlock), address(0), TREASURY, FEE);
    }

    function test_constructor_revertsOnZeroTreasury() public {
        vm.expectRevert(LaunchHelper.ZeroAddress.selector);
        new LaunchHelper(address(airlock), address(registry), address(0), FEE);
    }

    function test_constructor_revertsOnZeroFee() public {
        vm.expectRevert(LaunchHelper.ZeroFee.selector);
        new LaunchHelper(address(airlock), address(registry), TREASURY, 0);
    }

    // ── launch: happy paths ──────────────────────────────────────────────────

    function test_launch_withFee_createsRegistersAndForwardsFee() public {
        uint256 before = TREASURY.balance;
        address asset = airlock.nextAsset();

        vm.expectEmit(true, true, true, true, address(helper));
        emit Launched(LAUNCHER, asset, CREATOR, registry.ROUTER());
        vm.expectEmit(true, true, false, true, address(helper));
        emit LaunchFeePaid(LAUNCHER, asset, FEE);

        vm.prank(LAUNCHER);
        (address gotAsset, address router) = helper.launch{value: FEE}(_params(), CREATOR);

        assertEq(gotAsset, asset);
        assertEq(router, registry.ROUTER());
        assertEq(registry.lastAsset(), asset);
        assertEq(registry.lastCreator(), CREATOR);
        assertEq(airlock.lastSalt(), keccak256("salt"), "params forwarded unchanged");
        assertEq(TREASURY.balance - before, FEE, "treasury received the fee");
        assertEq(address(helper).balance, 0, "helper holds nothing");
    }

    function test_launch_withoutFee_launchesAndEmitsNoFeeEvent() public {
        uint256 before = TREASURY.balance;
        vm.recordLogs();
        vm.prank(LAUNCHER);
        helper.launch(_params(), CREATOR);

        assertEq(TREASURY.balance, before, "no fee moved");
        bytes32 feeTopic = keccak256("LaunchFeePaid(address,address,uint256)");
        VmLogs memory l = VmLogs(vm.getRecordedLogs());
        for (uint256 i; i < l.logs.length; ++i) {
            assertTrue(l.logs[i].topics[0] != feeTopic, "LaunchFeePaid must not be emitted without a fee");
        }
    }

    struct VmLogs {
        Vm.Log[] logs;
    }

    function test_launch_creatorMayDifferFromLauncher() public {
        vm.prank(LAUNCHER);
        helper.launch{value: FEE}(_params(), CREATOR);
        assertEq(registry.lastCreator(), CREATOR);
        assertTrue(CREATOR != LAUNCHER);
    }

    // ── launch: reverts ──────────────────────────────────────────────────────

    function test_launch_revertsOnUnderpaidFee() public {
        vm.prank(LAUNCHER);
        vm.expectRevert(abi.encodeWithSelector(LaunchHelper.WrongFee.selector, FEE - 1, FEE));
        helper.launch{value: FEE - 1}(_params(), CREATOR);
    }

    function test_launch_revertsOnOverpaidFee() public {
        vm.prank(LAUNCHER);
        vm.expectRevert(abi.encodeWithSelector(LaunchHelper.WrongFee.selector, FEE + 1, FEE));
        helper.launch{value: FEE + 1}(_params(), CREATOR);
    }

    function test_launch_revertsOnZeroCreator() public {
        vm.prank(LAUNCHER);
        vm.expectRevert(LaunchHelper.ZeroAddress.selector);
        helper.launch{value: FEE}(_params(), address(0));
    }

    function test_launch_airlockRevert_takesNoFee() public {
        airlock.setRevert(true);
        uint256 before = LAUNCHER.balance;
        vm.prank(LAUNCHER);
        vm.expectRevert(bytes("airlock: create failed"));
        helper.launch{value: FEE}(_params(), CREATOR);
        assertEq(LAUNCHER.balance, before, "fee refunded by revert");
        assertEq(TREASURY.balance, 0);
    }

    function test_launch_registerRevert_bubblesAndTakesNoFee() public {
        registry.setRevert(true);
        uint256 before = LAUNCHER.balance;
        vm.prank(LAUNCHER);
        vm.expectRevert(abi.encodeWithSelector(MockRegistry.WrongCreatorShare.selector, 0, 0.35e18));
        helper.launch{value: FEE}(_params(), CREATOR);
        assertEq(LAUNCHER.balance, before);
        assertEq(TREASURY.balance, 0);
    }

    function test_launch_treasuryRejects_reverts() public {
        RejectingTreasury t = new RejectingTreasury();
        LaunchHelper h = new LaunchHelper(address(airlock), address(registry), address(t), FEE);
        vm.prank(LAUNCHER);
        vm.expectRevert(); // SafeTransferLib.ETHTransferFailed
        h.launch{value: FEE}(_params(), CREATOR);
        assertEq(address(h).balance, 0);
    }

    function test_launch_reentrancyFromTreasuryBlocked() public {
        ReentrantTreasury t = new ReentrantTreasury();
        LaunchHelper h = new LaunchHelper(address(airlock), address(registry), address(t), FEE);
        t.setHelper(h);
        vm.prank(LAUNCHER);
        h.launch{value: FEE}(_params(), CREATOR);
        assertFalse(t.reentered(), "re-entry must fail");
        assertEq(bytes4(t.reentryError()), bytes4(keccak256("Reentrancy()")), "solady ReentrancyGuard");
        assertEq(address(t).balance, FEE);
    }

    function test_noReceiveOrFallback() public {
        vm.prank(LAUNCHER);
        (bool ok,) = address(helper).call{value: 1 ether}("");
        assertFalse(ok, "plain MON transfers are rejected");
    }

    // ── Fuzz ─────────────────────────────────────────────────────────────────

    /// Any value other than 0 or the exact fee reverts; accepted values leave the helper empty.
    function testFuzz_launch_feeIsExactOrZero(uint256 value) public {
        value = bound(value, 0, 100 ether);
        uint256 treasuryBefore = TREASURY.balance;
        vm.prank(LAUNCHER);
        if (value != 0 && value != FEE) {
            vm.expectRevert(abi.encodeWithSelector(LaunchHelper.WrongFee.selector, value, FEE));
            helper.launch{value: value}(_params(), CREATOR);
            assertEq(TREASURY.balance, treasuryBefore);
        } else {
            helper.launch{value: value}(_params(), CREATOR);
            assertEq(TREASURY.balance - treasuryBefore, value, "treasury gets exactly the fee");
        }
        assertEq(address(helper).balance, 0);
    }

    function testFuzz_launch_forwardsAnyCreator(address creator) public {
        vm.assume(creator != address(0));
        vm.prank(LAUNCHER);
        helper.launch{value: FEE}(_params(), creator);
        assertEq(registry.lastCreator(), creator);
    }
}

import {Vm} from "forge-std/Vm.sol";

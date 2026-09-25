// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {LaunchHelper, CreateParams} from "../../src/LaunchHelper.sol";
import {MockAirlock, MockRegistry} from "../unit/LaunchHelper.t.sol";

/// @dev Random launches with random values and random registry/airlock failures.
contract LaunchHelperHandler is Test {
    LaunchHelper public helper;
    MockAirlock public airlock;
    MockRegistry public registry;
    address public treasury;

    uint256 public ghostFeesPaid; // sum of msg.value of successful launches
    uint256 public ghostSent; // sum of msg.value of all attempts

    constructor(LaunchHelper h, MockAirlock a, MockRegistry r, address t) {
        helper = h;
        airlock = a;
        registry = r;
        treasury = t;
    }

    function launch(uint256 valueSeed, bool failAirlock, bool failRegister, address creator) external {
        uint256 fee = helper.launchFee();
        uint256 v = valueSeed % 3 == 0 ? 0 : valueSeed % 3 == 1 ? fee : bound(valueSeed, 0, 3 * fee);
        airlock.setRevert(failAirlock);
        registry.setRevert(failRegister);
        vm.deal(address(this), address(this).balance + v);
        ghostSent += v;
        CreateParams memory p;
        try helper.launch{value: v}(p, creator) {
            ghostFeesPaid += v;
        } catch {}
        airlock.setRevert(false);
        registry.setRevert(false);
    }

    receive() external payable {}
}

contract LaunchHelperInvariants is StdInvariant, Test {
    LaunchHelper helper;
    LaunchHelperHandler handler;
    address constant TREASURY = address(0x888F);

    function setUp() public {
        MockAirlock airlock = new MockAirlock();
        MockRegistry registry = new MockRegistry();
        helper = new LaunchHelper(address(airlock), address(registry), TREASURY, 10 ether);
        handler = new LaunchHelperHandler(helper, airlock, registry, TREASURY);
        targetContract(address(handler));
    }

    /// No fund leakage: the helper never keeps MON.
    function invariant_helperHoldsNothing() public view {
        assertEq(address(helper).balance, 0);
    }

    /// The treasury receives exactly the fees of successful launches, nothing else.
    function invariant_treasuryGetsOnlySuccessfulFees() public view {
        assertEq(TREASURY.balance, handler.ghostFeesPaid());
    }

    /// Every successful paid launch paid exactly the fee (0 or launchFee per launch).
    function invariant_feesAreWholeMultiples() public view {
        assertEq(handler.ghostFeesPaid() % helper.launchFee(), 0);
    }
}

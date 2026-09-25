// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {InitializerV1Adapter} from "../../src/InitializerV1Adapter.sol";
import {IFeeAdapter} from "../../src/interfaces/IFeeAdapter.sol";
import {IInitializer, PoolKey} from "../../src/interfaces/IInitializer.sol";

// ── Mock initializer that records calls ──────────────────────────────────────
contract MockInitializerV1 {
    address public lastCollectCaller;
    bytes32 public lastCollectPoolId;

    uint256 public sharesReturn;
    PoolKey public statePoolKey;

    function collectFees(bytes32 poolId) external returns (uint128, uint128) {
        lastCollectCaller = msg.sender;
        lastCollectPoolId = poolId;
        return (100, 200);
    }

    function getShares(bytes32, address) external view returns (uint256) {
        return sharesReturn;
    }

    function getState(address)
        external
        view
        returns (address, uint8, PoolKey memory, int24)
    {
        return (address(0x1), 1, statePoolKey, -100);
    }

    function setSharesReturn(uint256 s) external { sharesReturn = s; }
    function setStatePoolKey(PoolKey calldata k) external { statePoolKey = k; }
}

// ── Tests ────────────────────────────────────────────────────────────────────
contract InitializerV1AdapterTest is Test {
    InitializerV1Adapter adapter;
    MockInitializerV1 init_;
    bytes32 poolId = keccak256("test-pool");

    function setUp() public {
        init_ = new MockInitializerV1();
        adapter = new InitializerV1Adapter(address(init_));
    }

    // ── Constructor ──────────────────────────────────────────────────────────
    function test_constructor_setsInitializer() public view {
        assertEq(adapter.initializer(), address(init_));
    }

    function test_constructor_revertsZeroAddress() public {
        vm.expectRevert(InitializerV1Adapter.ZeroAddress.selector);
        new InitializerV1Adapter(address(0));
    }

    // ── collectFeesCall ─────────────────────────────────────────────────────
    function test_collectFeesCall_returnsCorrectTarget() public view {
        (address target,) = adapter.collectFeesCall(poolId);
        assertEq(target, address(init_));
    }

    function test_collectFeesCall_returnsCorrectCalldata() public view {
        (, bytes memory data) = adapter.collectFeesCall(poolId);
        bytes memory expected = abi.encodeCall(IInitializer.collectFees, (poolId));
        assertEq(data, expected);
    }

    function test_collectFeesCall_callerExecutesCorrectly() public {
        (address target, bytes memory data) = adapter.collectFeesCall(poolId);
        (bool ok,) = target.call(data);
        assertTrue(ok);
        // msg.sender of doCollect is this test contract (the "beneficiary")
        assertEq(init_.lastCollectCaller(), address(this));
        assertEq(init_.lastCollectPoolId(), poolId);
    }

    // ── getShares ────────────────────────────────────────────────────────────
    function test_getShares_delegates() public {
        init_.setSharesReturn(0.2e18);
        uint256 shares = adapter.getShares(poolId, address(0xBEEF));
        assertEq(shares, 0.2e18);
    }

    // ── getState ─────────────────────────────────────────────────────────────
    function test_getState_delegates() public {
        PoolKey memory k = PoolKey({
            currency0: address(0x1),
            currency1: address(0x2),
            fee: 20000,
            tickSpacing: 200,
            hooks: address(0x3)
        });
        init_.setStatePoolKey(k);

        (address numeraire, uint8 status, PoolKey memory retKey, int24 farTick)
            = adapter.getState(address(0xA));

        assertEq(numeraire, address(0x1));
        assertEq(status, 1);
        assertEq(farTick, -100);
        assertEq(retKey.fee, 20000);
    }
}

// ── Second-initializer proof test ────────────────────────────────────────────

/// @dev Mock that records the caller of collectFees.
contract MockInitializerV2 {
    address public lastCaller;

    function collectFees(bytes32) external returns (uint128, uint128) {
        lastCaller = msg.sender;
        return (0, 0);
    }

    function getShares(bytes32, address) external pure returns (uint256) { return 0; }
    function getState(address)
        external
        pure
        returns (address, uint8, PoolKey memory, int24)
    {
        PoolKey memory k;
        return (address(0), 0, k, 0);
    }
}

contract AdapterProofTest is Test {
    /// @notice Proves that wrapping a different initializer in InitializerV1Adapter
    ///         still results in the beneficiary being msg.sender on collectFees.
    function test_secondInitializer_beneficiaryIsCaller() public {
        MockInitializerV2 mockV2 = new MockInitializerV2();
        InitializerV1Adapter adapter = new InitializerV1Adapter(address(mockV2));

        bytes32 poolId = keccak256("proof");
        (address target, bytes memory data) = adapter.collectFeesCall(poolId);

        // Simulate: an FeeEscrow-like contract calls target.call(data)
        address beneficiary = address(0xBEEF);
        vm.prank(beneficiary);
        (bool ok,) = target.call(data);
        assertTrue(ok);

        // Prove: the initializer saw the beneficiary as msg.sender
        assertEq(mockV2.lastCaller(), beneficiary);
    }
}

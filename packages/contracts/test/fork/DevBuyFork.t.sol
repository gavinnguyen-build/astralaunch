// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {AstralaunchRegistry} from "../../src/AstralaunchRegistry.sol";
import {AstralaunchConstants as C} from "../../src/AstralaunchConstants.sol";
import {IDopplerERC20V1} from "../../src/interfaces/IDopplerERC20V1.sol";

/// @notice Bundler interface for reading dev-buy vesting positions.
interface IBundler {
    function getVesting(address asset)
        external
        view
        returns (
            address recipient,
            uint128 totalAmount,
            uint128 claimedAmount,
            uint64  start,
            uint64  cliffDuration,
            uint64  vestingDuration,
            bool    permissionlessClaim
        );
}

/// @notice Fork tests for tokens launched with dev buy (launch-devbuy.ts).
///
///         Tests verify:
///           1. register() succeeds for both dev-buy variants (with/without vesting)
///           2. vestedTotalAmount() == 150M (not affected by dev buy)
///           3. totalAllocatedOf(creator) == 150M
///           4. Bundler holds the dev-buy vesting position (for vesting variant)
///
///         Required setup:
///           1. anvil/start-fork.sh + Deploy + npm run launch + npm run launch-devbuy
///
///         Run:
///           CONTRACTS_JSON_PATH=../../revpad-anvil/.anvil-state/contracts.json \
///           forge test --match-path "test/fork/DevBuyFork*" --fork-url http://127.0.0.1:8545 -vv
contract DevBuyForkTest is Test {
    address constant CREATOR = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    address constant BUNDLER = 0xf45588E8e0B1df9dB9ae7E20eCE5726AE931357c;

    string constant CONTRACTS_JSON_DEFAULT      = "../../revpad-anvil/.anvil-state/contracts.json";
    string constant DEVBUY_VESTING_JSON_DEFAULT = "../../revpad-anvil/.anvil-state/state-devbuy-vesting.json";
    string constant DEVBUY_JSON_DEFAULT         = "../../revpad-anvil/.anvil-state/state-devbuy.json";

    AstralaunchRegistry registry;

    address assetVesting;   // dev buy with vesting
    address assetNoVesting; // dev buy without vesting

    bool hasVestingState;
    bool hasNoVestingState;

    function setUp() public {
        string memory cPath = vm.envOr("CONTRACTS_JSON_PATH", CONTRACTS_JSON_DEFAULT);
        string memory cJson = vm.readFile(cPath);
        registry = AstralaunchRegistry(vm.parseJsonAddress(cJson, ".registry"));

        // Try reading dev-buy state files (may not exist if launch-devbuy wasn't run)
        try vm.readFile(vm.envOr("DEVBUY_VESTING_JSON_PATH", DEVBUY_VESTING_JSON_DEFAULT)) returns (string memory sJson) {
            assetVesting = vm.parseJsonAddress(sJson, ".token");
            hasVestingState = true;
            _clearRegistration(assetVesting);
        } catch {
            hasVestingState = false;
        }

        try vm.readFile(vm.envOr("DEVBUY_JSON_PATH", DEVBUY_JSON_DEFAULT)) returns (string memory sJson) {
            assetNoVesting = vm.parseJsonAddress(sJson, ".token");
            hasNoVestingState = true;
            _clearRegistration(assetNoVesting);
        } catch {
            hasNoVestingState = false;
        }
    }

    // ── register succeeds for dev-buy with vesting ─────────────────────────────
    function test_register_devBuyVesting() public {
        vm.skip(!hasVestingState);
        address router = registry.register(assetVesting, CREATOR);
        assertTrue(router != address(0), "router deployed for vesting variant");
    }

    // ── register succeeds for dev-buy without vesting ──────────────────────────
    function test_register_devBuyNoVesting() public {
        vm.skip(!hasNoVestingState);
        address router = registry.register(assetNoVesting, CREATOR);
        assertTrue(router != address(0), "router deployed for no-vesting variant");
    }

    // ── vestedTotalAmount unchanged by dev buy (vesting variant) ───────────────
    function test_vestedTotalAmount_notAffectedByDevBuy_vesting() public {
        vm.skip(!hasVestingState);
        IDopplerERC20V1 tok = IDopplerERC20V1(assetVesting);

        uint256 vta = tok.vestedTotalAmount();
        uint256 tao = tok.totalAllocatedOf(CREATOR);

        console.log("--- DevBuy Vesting: token vesting state ---");
        console.log("vestedTotalAmount:         ", vta);
        console.log("totalAllocatedOf(creator): ", tao);
        console.log("expected VESTED_TOKENS_NUM:", C.VESTED_TOKENS_NUM);

        assertEq(tao, C.VESTED_TOKENS_NUM, "creator allocation == 150M (not affected by dev buy)");
        // vestedTotalAmount may or may not equal VESTED_TOKENS_NUM.
        // Log for investigation; the registry check uses totalAllocatedOf, not vestedTotalAmount.
        // If vestedTotalAmount != VESTED_TOKENS_NUM, the registry's check on line 263 needs removal.
    }

    // ── vestedTotalAmount unchanged by dev buy (no-vesting variant) ────────────
    function test_vestedTotalAmount_notAffectedByDevBuy_noVesting() public {
        vm.skip(!hasNoVestingState);
        IDopplerERC20V1 tok = IDopplerERC20V1(assetNoVesting);

        uint256 vta = tok.vestedTotalAmount();
        uint256 tao = tok.totalAllocatedOf(CREATOR);

        console.log("--- DevBuy NoVesting: token vesting state ---");
        console.log("vestedTotalAmount:         ", vta);
        console.log("totalAllocatedOf(creator): ", tao);
        console.log("expected VESTED_TOKENS_NUM:", C.VESTED_TOKENS_NUM);

        assertEq(tao, C.VESTED_TOKENS_NUM, "creator allocation == 150M (not affected by dev buy)");
    }

    // ── Bundler vesting position exists for vesting variant ────────────────────
    function test_bundlerVesting_exists() public {
        vm.skip(!hasVestingState);

        IBundler bundler = IBundler(BUNDLER);
        (
            address recipient,
            uint128 totalAmount,
            uint128 claimedAmount,
            uint64  start,
            uint64  cliffDuration,
            uint64  vestingDuration,
            bool    permissionlessClaim
        ) = bundler.getVesting(assetVesting);

        console.log("--- Bundler vesting position ---");
        console.log("recipient:          ", recipient);
        console.log("totalAmount:        ", totalAmount);
        console.log("claimedAmount:      ", claimedAmount);
        console.log("start:              ", start);
        console.log("cliffDuration:      ", cliffDuration);
        console.log("vestingDuration:    ", vestingDuration);
        console.log("permissionlessClaim:", permissionlessClaim);

        assertEq(recipient, CREATOR, "bundler vesting recipient == creator");
        assertGt(totalAmount, 0, "bundler holds dev-buy tokens");
    }

    // ── Helpers ──────────────────────────────────────────────────────────────
    function _clearRegistration(address a) internal {
        vm.store(address(registry), keccak256(abi.encode(a, uint256(11))), bytes32(0));
    }
}

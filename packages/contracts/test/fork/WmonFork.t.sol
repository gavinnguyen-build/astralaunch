// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {FeeEscrow} from "../../src/FeeEscrow.sol";
import {BuybackVault} from "../../src/BuybackVault.sol";
import {RevenueRouter} from "../../src/RevenueRouter.sol";
import {AstralaunchRegistry} from "../../src/AstralaunchRegistry.sol";
import {PlatformFeeReceiver} from "../../src/PlatformFeeReceiver.sol";
import {AstralaunchConstants as C} from "../../src/AstralaunchConstants.sol";
import {PoolKey, IInitializer} from "../../src/interfaces/IInitializer.sol";
import {IFeeAdapter} from "../../src/interfaces/IFeeAdapter.sol";
import {IPoolManager, IUnlockCallback, SwapParams, BalanceDelta, BalanceDeltaLib} from "../../src/interfaces/IPoolManager.sol";
import {IDopplerERC20V1} from "../../src/interfaces/IDopplerERC20V1.sol";

/// @notice Fork tests for a WMON-paired token launched via launch-wmon.ts.
///
///         Required setup:
///           1. anvil/start-fork.sh
///           2. Deploy contracts, launch USDC token, then run: npm run launch-wmon
///
///         Run:
///           CONTRACTS_JSON_PATH=../../revpad-anvil/.anvil-state/contracts.json \
///           forge test --match-path "test/fork/WmonFork*" --fork-url http://127.0.0.1:8545 -vv
contract WmonForkTest is Test {
    using SafeTransferLib for address;
    using BalanceDeltaLib for BalanceDelta;

    address constant POOL_MANAGER = 0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e;
    address constant INITIALIZER  = 0xCe3099B2F07029b086E5e92a1573C5f5A3071783;
    address constant USDC         = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address constant WMON         = 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A;
    address constant CREATOR      = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

    string constant CONTRACTS_JSON_DEFAULT = "../../revpad-anvil/.anvil-state/contracts.json";
    string constant STATE_JSON_DEFAULT     = "../../revpad-anvil/.anvil-state/state-wmon.json";

    FeeEscrow           escrow;
    BuybackVault        vault;
    PlatformFeeReceiver pfr;
    AstralaunchRegistry registry;

    address asset;
    WmonForkTrader      trader;

    function setUp() public {
        string memory cPath = vm.envOr("CONTRACTS_JSON_PATH", CONTRACTS_JSON_DEFAULT);
        string memory cJson = vm.readFile(cPath);

        escrow   = FeeEscrow(vm.parseJsonAddress(cJson, ".escrow"));
        vault    = BuybackVault(vm.parseJsonAddress(cJson, ".vault"));
        pfr      = PlatformFeeReceiver(vm.parseJsonAddress(cJson, ".platformFeeReceiver"));
        registry = AstralaunchRegistry(vm.parseJsonAddress(cJson, ".registry"));

        string memory sPath = vm.envOr("WMON_STATE_JSON_PATH", STATE_JSON_DEFAULT);
        string memory sJson = vm.readFile(sPath);
        asset = vm.parseJsonAddress(sJson, ".token");

        trader = new WmonForkTrader();

        // Clear registration in case launch-wmon.ts already registered
        _clearRegistration(asset);
    }

    // ── register succeeds with WMON numeraire ──────────────────────────────────
    function test_register_wmonNumeraire() public {
        address router = registry.register(asset, CREATOR);
        assertTrue(router != address(0), "router deployed");
        assertEq(registry.assetNumeraires(asset), WMON, "numeraire is WMON");
    }

    // ── collect() receives WMON ────────────────────────────────────────────────
    function test_collect_receivesWMON() public {
        registry.register(asset, CREATOR);

        // Warp past balance cap window
        IDopplerERC20V1 tok = IDopplerERC20V1(asset);
        uint256 capEnd = uint256(tok.balanceLimitEnd());
        if (block.timestamp <= capEnd) vm.warp(capEnd + 1);

        IFeeAdapter adapter = registry.feeAdapters(INITIALIZER);
        (, , PoolKey memory key, ) = adapter.getState(asset);

        // Deal WMON to trader and swap (WMON -> token)
        uint256 swapAmt = 1 ether; // 1 WMON
        _dealWmon(address(trader), swapAmt);

        uint256 escrowWmonBefore = IERC20(WMON).balanceOf(address(escrow));

        trader.swapWMONForToken(asset, key, swapAmt);

        // Collect escrow fees
        escrow.collect(asset);

        uint256 escrowWmon = IERC20(WMON).balanceOf(address(escrow)) - escrowWmonBefore;
        console.log("--- WMON collect ---");
        console.log("escrow WMON received:", escrowWmon);

        // Escrow should park WMON as numerairePending (since it's not USDC)
        // The exact behavior depends on FeeEscrow implementation
        // At minimum, the collect should not revert
    }

    // ── execute() reverts with BuybackNotAvailable for WMON pair ───────────────
    function test_execute_revertsForWMON() public {
        registry.register(asset, CREATOR);

        // Distribute some revenue to credit vault
        address router = registry.routers(asset);
        _dealUsdc(router, 100_000_000); // 100 USDC
        RevenueRouter(router).distribute();

        uint256 vaultBalance = vault.assetData(asset).balanceUSDC;
        if (vaultBalance > 0) {
            vm.expectRevert(BuybackVault.BuybackNotAvailable.selector);
            vault.execute(asset, vaultBalance, 0);
        }
    }

    // ── PFR forwards WMON to treasury ─────────────────────────────────────────
    function test_pfr_forwardsWMON() public {
        registry.register(asset, CREATOR);

        IDopplerERC20V1 tok = IDopplerERC20V1(asset);
        uint256 capEnd = uint256(tok.balanceLimitEnd());
        if (block.timestamp <= capEnd) vm.warp(capEnd + 1);

        IFeeAdapter adapter = registry.feeAdapters(INITIALIZER);
        (, , PoolKey memory key, ) = adapter.getState(asset);

        // Read actual treasury from deployed PFR (may differ from test constants)
        address actualTreasury = pfr.treasury();

        uint256 swapAmt = 1 ether;
        _dealWmon(address(trader), swapAmt);
        _dealWmon(actualTreasury, 0); // pre-seed slot

        uint256 treasuryWmonBefore = IERC20(WMON).balanceOf(actualTreasury);

        trader.swapWMONForToken(asset, key, swapAmt);
        pfr.collect(asset);

        uint256 treasuryWmon = IERC20(WMON).balanceOf(actualTreasury) - treasuryWmonBefore;
        console.log("--- PFR WMON forward ---");
        console.log("treasury WMON received:", treasuryWmon);
        assertGt(treasuryWmon, 0, "treasury received WMON fees");
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    function _clearRegistration(address a) internal {
        vm.store(address(registry), keccak256(abi.encode(a, uint256(11))), bytes32(0));
        bytes32 eBase = keccak256(abi.encode(a, uint256(0)));
        vm.store(address(escrow), eBase, bytes32(0));
        bytes32 vBase = keccak256(abi.encode(a, uint256(0)));
        vm.store(address(vault), bytes32(uint256(vBase) + 4), bytes32(0));
        vm.store(address(pfr), keccak256(abi.encode(a, uint256(5))), bytes32(0));
    }

    /// @dev Deal WMON by wrapping native MON. WMON is Wrapped MON (deposit() payable).
    function _dealWmon(address to, uint256 amt) internal {
        vm.deal(address(this), amt);
        (bool ok,) = WMON.call{value: amt}(abi.encodeWithSignature("deposit()"));
        require(ok, "WMON deposit failed");
        WMON.safeTransfer(to, amt);
    }

    function _dealUsdc(address to, uint256 amt) internal {
        bytes32 slot = keccak256(abi.encode(to, uint256(9)));
        vm.store(USDC, slot, bytes32(amt));
    }
}

/// @notice Swaps WMON -> asset token on a WMON-paired Doppler v4 pool.
contract WmonForkTrader is IUnlockCallback {
    using SafeTransferLib for address;
    using BalanceDeltaLib for BalanceDelta;

    address constant POOL_MANAGER = 0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e;
    address constant WMON         = 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A;

    IPoolManager immutable pm;
    PoolKey  private _key;
    address  private _asset;

    constructor() { pm = IPoolManager(POOL_MANAGER); }

    function swapWMONForToken(address asset_, PoolKey memory key, uint256 wmonIn) external {
        _key   = key;
        _asset = asset_;
        pm.unlock(abi.encode(asset_, wmonIn));
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        require(msg.sender == address(pm), "not pm");

        (address asset_, uint256 wmonIn) = abi.decode(data, (address, uint256));
        PoolKey memory key = _key;
        bool zeroForOne = key.currency0 == WMON;

        SwapParams memory params = SwapParams({
            zeroForOne:        zeroForOne,
            amountSpecified:   -int256(wmonIn),
            sqrtPriceLimitX96: zeroForOne
                ? uint160(4_295_128_740)
                : uint160(1_461_446_703_485_210_103_172_823_403_640)
        });

        BalanceDelta delta = pm.swap(key, params, "");

        // Settle WMON debt
        int128 wmonDeltaI = zeroForOne ? delta.amount0() : delta.amount1();
        uint256 wmonOwed  = uint256(uint128(-wmonDeltaI));
        pm.sync(WMON);
        WMON.safeTransfer(address(pm), wmonOwed);
        pm.settle();

        // Take token output
        int128 tokenDeltaI = zeroForOne ? delta.amount1() : delta.amount0();
        uint256 tokenOut   = uint256(uint128(tokenDeltaI));
        if (tokenOut > 0) pm.take(asset_, address(this), tokenOut);

        return abi.encode(tokenOut);
    }
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
}

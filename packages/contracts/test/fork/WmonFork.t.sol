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
import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";

/// @notice Fork tests for WMON-paired tokens: two-hop buyback, oracle-valued escrow, wash check.
///
///         Requires: anvil/start-fork.sh, deploy, npm run launch, npm run launch-wmon.
///         The WMON token is already registered on-chain; tests use it directly.
///
///         Run:
///           forge test --match-path "test/fork/WmonFork*" --fork-url http://127.0.0.1:8545 --threads 1 -vv
contract WmonForkTest is Test {
    using SafeTransferLib for address;
    using BalanceDeltaLib for BalanceDelta;

    address constant POOL_MANAGER    = 0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e;
    address constant INITIALIZER     = 0xCe3099B2F07029b086E5e92a1573C5f5A3071783;
    address constant USDC            = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address constant WMON            = 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A;
    address constant MON_USD_ORACLE  = 0xBcD78f76005B7515837af6b50c7C52BCf73822fb;
    address constant CREATOR         = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

    string constant CONTRACTS_JSON_DEFAULT = "../../astralaunch-anvil/.anvil-state/contracts.json";
    string constant STATE_JSON_DEFAULT     = "../../astralaunch-anvil/.anvil-state/state-wmon.json";

    FeeEscrow           escrow;
    BuybackVault        vault;
    PlatformFeeReceiver pfr;
    AstralaunchRegistry registry;

    address asset;
    address router;
    WmonForkTrader      trader;

    function setUp() public {
        string memory cPath = vm.envOr("CONTRACTS_JSON_PATH", CONTRACTS_JSON_DEFAULT);
        string memory cJson = vm.readFile(cPath);

        escrow   = FeeEscrow(vm.parseJsonAddress(cJson, ".escrow"));
        vault    = BuybackVault(payable(vm.parseJsonAddress(cJson, ".vault")));
        pfr      = PlatformFeeReceiver(vm.parseJsonAddress(cJson, ".platformFeeReceiver"));
        registry = AstralaunchRegistry(vm.parseJsonAddress(cJson, ".registry"));

        string memory sPath = vm.envOr("WMON_STATE_JSON_PATH", STATE_JSON_DEFAULT);
        string memory sJson = vm.readFile(sPath);
        asset = vm.parseJsonAddress(sJson, ".token");

        // Asset was already registered by launch-wmon.ts — use it directly
        router = registry.routers(asset);
        require(router != address(0), "WMON token not registered on fork");

        trader = new WmonForkTrader();
    }

    // ── Numeraire is WMON ───────────────────────────────────────────────────────
    function test_register_wmonNumeraire() public view {
        assertEq(registry.assetNumeraires(asset), WMON, "numeraire is WMON");
    }

    // ── collect() receives WMON ────────────────────────────────────────────────
    function test_collect_receivesWMON() public {
        // Warp past balance cap window
        IDopplerERC20V1 tok = IDopplerERC20V1(asset);
        uint256 capEnd = uint256(tok.balanceLimitEnd());
        if (block.timestamp <= capEnd) vm.warp(capEnd + 1);

        IFeeAdapter adapter = registry.feeAdapters(INITIALIZER);
        (, , PoolKey memory key, ) = adapter.getState(asset);

        uint256 swapAmt = 1 ether;
        _dealWmon(address(trader), swapAmt);

        uint256 escrowWmonBefore = IERC20(WMON).balanceOf(address(escrow));

        trader.swapWMONForToken(asset, key, swapAmt);
        escrow.collect(asset);

        uint256 escrowWmon = IERC20(WMON).balanceOf(address(escrow)) - escrowWmonBefore;
        console.log("--- WMON collect ---");
        console.log("escrow WMON received:", escrowWmon);
    }

    // ── Two-hop buyback: USDC→MON→WMON→token→burn against real v4 pool ──────
    function test_twoHopBuyback_burnTokens() public {
        // Distribute USDC revenue to credit vault
        _dealUsdc(router, 10_000_000); // 10 USDC
        RevenueRouter(router).distribute();

        uint256 vaultBalance = vault.assetData(asset).balanceUSDC;
        console.log("--- Two-hop buyback ---");
        console.log("vault USDC balance:", vaultBalance);
        assertGt(vaultBalance, 0, "vault has USDC");

        // Warp past MIN_INTERVAL if needed
        BuybackVault.AssetData memory d = vault.assetData(asset);
        if (block.timestamp < uint256(d.lastExecuteTime) + C.BUYBACK_MIN_INTERVAL) {
            vm.warp(uint256(d.lastExecuteTime) + C.BUYBACK_MIN_INTERVAL + 1);
        }

        // Verify MON/USDC pool key is set
        (address c0, address c1, uint24 fee, int24 ts, ) = vault.monUsdcPoolKey();
        console.log("MON/USDC key: c0=", c0);
        console.log("  c1=", c1, "fee=", fee);
        assertEq(c0, address(0), "currency0 is native MON");
        assertEq(c1, USDC,       "currency1 is USDC");
        assertEq(fee, 500,       "fee is 0.05%");
        assertEq(ts, 10,         "tickSpacing is 10");

        // Record token supply before buyback
        uint256 supplyBefore = IERC20(asset).totalSupply();
        console.log("token supply before:", supplyBefore);

        // Execute two-hop buyback (USDC → MON → WMON → token → burn)
        vault.execute(asset, vaultBalance, 0, 0);

        uint256 supplyAfter = IERC20(asset).totalSupply();
        uint256 burned = supplyBefore - supplyAfter;
        console.log("token supply after: ", supplyAfter);
        console.log("tokens burned:      ", burned);

        // Tokens MUST have been burned
        assertGt(burned, 0, "tokens were burned via two-hop buyback");
        assertEq(vault.assetData(asset).balanceUSDC, 0, "vault balance drained");
    }

    // ── Escrow claim for WMON token valued by real Chainlink feed ────────────
    function test_claimWmon_oracleValuation() public {
        // 1. Record revenue (so escrow unlock has an allowance)
        _dealUsdc(router, 100_000_000); // 100 USDC
        RevenueRouter(router).distribute();

        // 2. Generate WMON trading fees and collect into escrow
        IDopplerERC20V1 tok = IDopplerERC20V1(asset);
        uint256 capEnd = uint256(tok.balanceLimitEnd());
        if (block.timestamp <= capEnd) vm.warp(capEnd + 1);

        IFeeAdapter adapter = registry.feeAdapters(INITIALIZER);
        (, , PoolKey memory key, ) = adapter.getState(asset);

        _dealWmon(address(trader), 5 ether);
        trader.swapWMONForToken(asset, key, 5 ether);
        escrow.collect(asset);

        FeeEscrow.WmonData memory w = escrow.wmonData(asset);
        console.log("--- WMON escrow claim ---");
        console.log("wmonAccrued:", w.wmonAccrued);
        assertGt(w.wmonAccrued, 0, "WMON accrued in escrow");

        // 3. Verify oracle is live and warp to freshness window
        (, int256 answer, , uint256 updatedAt, ) = IAggregatorV3(MON_USD_ORACLE).latestRoundData();
        console.log("oracle answer:    ", uint256(answer));
        console.log("oracle updatedAt: ", updatedAt);
        assertGt(answer, 0, "oracle price > 0");
        // On a pinned fork, the oracle may be stale relative to block.timestamp.
        // Warp to within the staleness window.
        if (block.timestamp > updatedAt + C.MAX_ORACLE_STALENESS) {
            vm.warp(updatedAt + C.MAX_ORACLE_STALENESS - 10);
        }

        // 4. Claim WMON as creator
        uint256 claimableWmon = escrow.claimableWmon(asset);
        console.log("claimableWmon:    ", claimableWmon);
        assertGt(claimableWmon, 0, "creator has claimable WMON");

        uint256 creatorWmonBefore = IERC20(WMON).balanceOf(CREATOR);
        vm.prank(CREATOR);
        escrow.claim(asset);
        uint256 creatorWmonAfter = IERC20(WMON).balanceOf(CREATOR);

        uint256 received = creatorWmonAfter - creatorWmonBefore;
        console.log("WMON received:    ", received);
        assertGt(received, 0, "creator received WMON");

        // Verify wmonClaimedUsd was updated
        FeeEscrow.WmonData memory w2 = escrow.wmonData(asset);
        assertGt(w2.wmonClaimedUsd, 0, "wmonClaimedUsd updated");
        console.log("wmonClaimedUsd:   ", w2.wmonClaimedUsd);
    }

    // ── Wash check: ESCROW_UNLOCK_BPS < 10000 - PROVIDER_BPS ────────────────
    function test_washCheck_wmonPair() public view {
        console.log("--- Wash check ---");
        console.log("ESCROW_UNLOCK_BPS:", C.ESCROW_UNLOCK_BPS);
        console.log("PROVIDER_BPS:     ", C.PROVIDER_BPS);
        console.log("10000 - PROVIDER: ", 10_000 - C.PROVIDER_BPS);
        assertTrue(C.ESCROW_UNLOCK_BPS < 10_000 - C.PROVIDER_BPS, "wash constraint holds");
    }

    // ── PFR forwards WMON to treasury ─────────────────────────────────────────
    function test_pfr_forwardsWMON() public {
        IDopplerERC20V1 tok = IDopplerERC20V1(asset);
        uint256 capEnd = uint256(tok.balanceLimitEnd());
        if (block.timestamp <= capEnd) vm.warp(capEnd + 1);

        IFeeAdapter adapter = registry.feeAdapters(INITIALIZER);
        (, , PoolKey memory key, ) = adapter.getState(asset);

        address actualTreasury = pfr.treasury();

        uint256 swapAmt = 1 ether;
        _dealWmon(address(trader), swapAmt);
        _dealWmon(actualTreasury, 0);

        uint256 treasuryWmonBefore = IERC20(WMON).balanceOf(actualTreasury);

        trader.swapWMONForToken(asset, key, swapAmt);
        pfr.collect(asset);

        uint256 treasuryWmon = IERC20(WMON).balanceOf(actualTreasury) - treasuryWmonBefore;
        console.log("--- PFR WMON forward ---");
        console.log("treasury WMON received:", treasuryWmon);
        assertGt(treasuryWmon, 0, "treasury received WMON fees");
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

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

    constructor() { pm = IPoolManager(POOL_MANAGER); }

    function swapWMONForToken(address asset_, PoolKey memory key, uint256 wmonIn) external {
        _key = key;
        pm.unlock(abi.encode(asset_, wmonIn));
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        require(msg.sender == address(pm), "not pm");

        (address asset_, uint256 wmonIn) = abi.decode(data, (address, uint256));
        PoolKey memory key = _key;
        bool zeroForOne = key.currency0 == WMON;

        BalanceDelta delta = pm.swap(key, SwapParams({
            zeroForOne:        zeroForOne,
            amountSpecified:   -int256(wmonIn),
            sqrtPriceLimitX96: zeroForOne
                ? uint160(4_295_128_740)
                : uint160(1_461_446_703_485_210_103_172_823_403_640)
        }), "");

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
    function totalSupply() external view returns (uint256);
}

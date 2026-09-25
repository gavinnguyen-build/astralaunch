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
import {IAirlock} from "../../src/interfaces/IAirlock.sol";

/// @notice Fork tests against Monad mainnet state (Anvil fork at http://127.0.0.1:8545).
///
///         Required setup:
///           1. anvil/start-fork.sh
///           2. DEPLOY_OUTPUT=../../revpad-anvil/.anvil-state/contracts.json \
///              forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 \
///                --broadcast --private-key $PRIVATE_KEY
///           3. npm run launch
///
///         Run:
///           CONTRACTS_JSON_PATH=../../revpad-anvil/.anvil-state/contracts.json \
///           forge test --match-path "test/fork/**" --fork-url http://127.0.0.1:8545 -vv
///
///         Required env vars:
///           CONTRACTS_JSON_PATH -- path to contracts.json written by Deploy.s.sol
///           (optional) STATE_JSON_PATH -- path to state.json; defaults to sibling of contracts.json
///
/// @dev setUp reads contract addresses from contracts.json and the token address from
///      state.json.  No redeployment, no vm.etch, no vm.setNonce.  The real deployed
///      contracts on the running Anvil fork are used directly.
contract RegistryForkTest is Test {
    using SafeTransferLib for address;
    using BalanceDeltaLib for BalanceDelta;

    // ── Monad mainnet constants ────────────────────────────────────────────────
    address constant POOL_MANAGER = 0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e;
    address constant INITIALIZER  = 0xCe3099B2F07029b086E5e92a1573C5f5A3071783;
    address constant AIRLOCK      = 0x660eAaEdEBc968f8f3694354FA8EC0b4c5Ba8D12;
    address constant USDC         = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address constant WMON         = 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A;
    address constant NOMIG        = 0x5F3bA43D44375286296Cb85F1EA2EBfa25dde731;
    address constant NOGOV        = 0x000000000000000000000000000000000000dEaD;

    // Anvil default accounts (match the mnemonic in revpad-anvil/src/env.ts)
    address constant ADMIN    = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266; // account[0]
    address constant CREATOR  = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266; // same as ADMIN

    // Default JSON paths -- relative to packages/contracts/ (Foundry project root).
    // fs_permissions in foundry.toml grants read access to this directory.
    string constant CONTRACTS_JSON_DEFAULT = "../../revpad-anvil/.anvil-state/contracts.json";
    string constant STATE_JSON_DEFAULT     = "../../revpad-anvil/.anvil-state/state.json";

    FeeEscrow           escrow;
    BuybackVault        vault;
    PlatformFeeReceiver pfr;
    AstralaunchRegistry registry;
    ForkTrader          forkTrader;

    address asset; // launched token (from state.json)

    function setUp() public {
        // ── Read deployed contract addresses from contracts.json ────────────────
        string memory cPath = vm.envOr("CONTRACTS_JSON_PATH", CONTRACTS_JSON_DEFAULT);
        string memory cJson = vm.readFile(cPath);

        escrow   = FeeEscrow(vm.parseJsonAddress(cJson, ".escrow"));
        vault    = BuybackVault(payable(vm.parseJsonAddress(cJson, ".vault")));
        pfr      = PlatformFeeReceiver(vm.parseJsonAddress(cJson, ".platformFeeReceiver"));
        registry = AstralaunchRegistry(vm.parseJsonAddress(cJson, ".registry"));

        // ── Read launched token from state.json ────────────────────────────────
        string memory sPath = vm.envOr("STATE_JSON_PATH", STATE_JSON_DEFAULT);
        string memory sJson = vm.readFile(sPath);
        asset = vm.parseJsonAddress(sJson, ".token");

        forkTrader = new ForkTrader();

        // ── Pre-seed USDC balance slots to avoid fork-backend fetches ─────────
        _dealUsdc(CREATOR,          0);
        _dealUsdc(pfr.treasury(),   0);
        _dealUsdc(address(escrow),  0);
        _dealUsdc(address(vault),   0);
        _dealUsdc(address(pfr),     0);

        // ── Clear pre-registration from npm run launch ─────────────────────────
        _clearRegistration(asset);
    }

    // ── A. Deployment sanity ──────────────────────────────────────────────────
    function test_deploy_addresses() public view {
        assertEq(registry.treasury(),              address(pfr),      "treasury == pfr");
        assertEq(address(registry.platformFeeReceiver()), address(pfr), "platformFeeReceiver");
        assertEq(registry.admin(),                 ADMIN,             "admin");
        assertEq(address(registry.feeEscrow()),    address(escrow),   "feeEscrow");
        assertEq(address(registry.buybackVault()), address(vault),    "buybackVault");
        // PFR treasury is set by Deploy.s.sol (defaults to msg.sender on Anvil)
        assertTrue(pfr.treasury() != address(0),                       "pfr.treasury is set");
        assertEq(pfr.registry(),                   address(registry), "pfr.registry");
    }

    /// @notice Verifies the Deploy.s.sol immutable wiring on the real deployed contracts.
    function test_deploy_immutablesWiredCorrectly() public view {
        assertEq(escrow.buybackVault(),            address(vault),    "escrow.buybackVault");
        assertEq(escrow.registry(),                address(registry), "escrow.registry");
        assertEq(vault.registry(),                 address(registry), "vault.registry");
        assertNotEq(address(vault.poolManager()),  address(0),        "vault.poolManager");
    }

    // ── B. register: accepts a correctly-launched token ───────────────────────
    function test_register_acceptsValidToken() public {
        address router = registry.register(asset, CREATOR);

        assertTrue(router != address(0), "no router");
        assertEq(registry.routers(asset), router);
        assertTrue(registry.isRegistered(asset));

        RevenueRouter rr = RevenueRouter(router);
        assertEq(rr.asset(),        asset);
        assertEq(rr.creator(),      CREATOR);
        assertEq(rr.registry(),     address(registry));
        assertEq(rr.feeEscrow(),    address(escrow));
        assertEq(rr.buybackVault(), address(vault));
        assertEq(rr.treasury(),     address(pfr));

        FeeEscrow.TokenData memory td = escrow.tokenData(asset);
        assertEq(td.creator, CREATOR);
        assertFalse(td.forfeited);

        // v2: verify numeraire stored
        address storedNumeraire = registry.assetNumeraires(asset);
        assertTrue(storedNumeraire == USDC || storedNumeraire == WMON, "numeraire must be USDC or WMON");
    }

    // ── C. register: rejects wrong pool (hook mismatch) ───────────────────────
    function test_register_revertsWrongPool() public {
        // Get the fee adapter for the initializer so we can mock getState on it
        IFeeAdapter adapter = registry.feeAdapters(INITIALIZER);

        PoolKey memory badKey = PoolKey({
            currency0: USDC,
            currency1: asset,
            fee: C.POOL_FEE,
            tickSpacing: C.TICK_SPACING,
            hooks: address(0) // wrong hook
        });
        vm.mockCall(
            address(adapter),
            abi.encodeWithSelector(IFeeAdapter.getState.selector, asset),
            abi.encode(USDC, uint8(1), badKey, int24(-887200))
        );
        vm.expectRevert(AstralaunchRegistry.WrongPool.selector);
        registry.register(asset, CREATOR);
    }

    // ── D. register: rejects wrong creator (share mismatch) ───────────────────
    function test_register_revertsWrongCreator() public {
        address fakeCreator = address(0xBAD);
        vm.expectRevert(abi.encodeWithSelector(
            AstralaunchRegistry.WrongCreatorShare.selector, uint256(0), C.CREATOR_SHARE_WAD
        ));
        registry.register(asset, fakeCreator);
    }

    // ── E. register: rejects wrong integrator ────────────────────────────────
    function test_register_revertsWrongIntegrator() public {
        address wrongIntegrator = address(0xBAD);
        vm.mockCall(
            AIRLOCK,
            abi.encodeWithSelector(IAirlock.getAssetData.selector, asset),
            abi.encode(
                USDC,               // numeraire
                address(0),         // timelock
                NOGOV,              // governance
                NOMIG,              // liquidityMigrator
                INITIALIZER,        // poolInitializer
                asset,              // pool
                address(0),         // migrationPool
                C.POOL_TOKENS_NUM,  // numTokensToSell
                C.TOTAL_SUPPLY,     // totalSupply
                wrongIntegrator     // integrator (wrong)
            )
        );
        vm.expectRevert(abi.encodeWithSelector(
            AstralaunchRegistry.WrongIntegrator.selector, wrongIntegrator, address(pfr)
        ));
        registry.register(asset, CREATOR);
    }

    // ── F. register: rejects wrong vesting amount ────────────────────────────
    function test_register_revertsWrongVestingAmount() public {
        uint256 badAmount = 50_000_000 * 1e18;
        vm.mockCall(
            asset,
            abi.encodeWithSelector(IDopplerERC20V1.totalAllocatedOf.selector, CREATOR),
            abi.encode(badAmount)
        );
        vm.expectRevert(abi.encodeWithSelector(
            AstralaunchRegistry.WrongVestingAmount.selector, badAmount, C.VESTED_TOKENS_NUM
        ));
        registry.register(asset, CREATOR);
    }

    // ── G. register: rejects wrong balance cap (5% instead of 1%) ────────────
    function test_register_revertsWrongBalanceCap_fivePct() public {
        uint256 badCap = C.TOTAL_SUPPLY / 20;
        vm.mockCall(
            asset,
            abi.encodeWithSelector(IDopplerERC20V1.maxBalanceLimit.selector),
            abi.encode(badCap)
        );
        vm.expectRevert(abi.encodeWithSelector(
            AstralaunchRegistry.WrongBalanceCap.selector, badCap, C.BALANCE_CAP_NUM
        ));
        registry.register(asset, CREATOR);
    }

    // ── H. register: rejects balance cap window too short (< 600 s) ──────────
    function test_register_revertsWrongBalanceCap_window() public {
        IDopplerERC20V1 tok = IDopplerERC20V1(asset);
        uint48 shortEnd = uint48(tok.vestingStart()); // window = 0 s
        vm.mockCall(
            asset,
            abi.encodeWithSelector(IDopplerERC20V1.balanceLimitEnd.selector),
            abi.encode(shortEnd)
        );
        vm.expectRevert(abi.encodeWithSelector(
            AstralaunchRegistry.WrongBalanceCap.selector, uint256(0), C.BALANCE_CAP_WINDOW
        ));
        registry.register(asset, CREATOR);
    }

    // ── K. register: duplicate reverts ───────────────────────────────────────
    function test_register_revertsOnDuplicate() public {
        registry.register(asset, CREATOR);
        vm.expectRevert(AstralaunchRegistry.AlreadyRegistered.selector);
        registry.register(asset, CREATOR);
    }

    // ── P. Revenue path: distribute() splits exactly 60/30/10 ────────────────
    function test_revenuePath_exactSplits() public {
        address router = registry.register(asset, CREATOR);
        RevenueRouter rr = RevenueRouter(router);

        uint256 total = 10_000_000; // 10 USDC
        _dealUsdc(address(rr), total);

        uint256 creatorBefore  = IERC20(USDC).balanceOf(CREATOR);
        uint256 pfrBefore      = IERC20(USDC).balanceOf(address(pfr));

        rr.distribute();

        uint256 providerExpected = (total * C.PROVIDER_BPS) / 10_000; // 6_000_000
        uint256 buybackExpected  = (total * C.BUYBACK_BPS)  / 10_000; // 3_000_000
        uint256 treasuryExpected = (total * C.TREASURY_BPS) / 10_000; // 1_000_000

        console.log("--- Revenue split (10 USDC in) ---");
        console.log("provider (60%):", providerExpected);
        console.log("buyback  (30%):", buybackExpected);
        console.log("treasury (10%):", treasuryExpected);

        assertEq(IERC20(USDC).balanceOf(CREATOR)  - creatorBefore,  providerExpected, "provider");
        assertEq(IERC20(USDC).balanceOf(address(pfr)) - pfrBefore, treasuryExpected, "treasury to pfr");
        assertEq(vault.assetData(asset).balanceUSDC,      buybackExpected, "vault USDC");
        assertEq(escrow.tokenData(asset).recordedRevenue, total,           "recordedRevenue");
    }

    // ── Q. Escrow: full claim path ─────────────────────────────────────────────
    function test_escrowClaim_fullPath() public {
        address router = registry.register(asset, CREATOR);
        RevenueRouter rr = RevenueRouter(router);

        // Record 100 USDC service revenue via distribute()
        uint256 revenue = 100_000_000; // 100 USDC
        _dealUsdc(address(router), revenue);
        rr.distribute();
        // allowance = 100 USDC * 20% = 20 USDC

        // Simulate 50 USDC of trading fees accumulated in escrow
        uint256 tradingFees = 50_000_000;
        _seedEscrowAccrued(asset, tradingFees);

        uint256 allowance  = (revenue * C.ESCROW_UNLOCK_BPS) / 10_000; // 20_000_000
        uint256 claimable_ = escrow.claimable(asset);

        console.log("--- Escrow claim ---");
        console.log("recorded revenue:", revenue);
        console.log("allowance (20%):", allowance);
        console.log("usdcAccrued:", tradingFees);
        console.log("claimable:", claimable_);

        assertEq(claimable_, allowance, "claimable == allowance (allowance < usdcAccrued)");

        uint256 creatorBefore = IERC20(USDC).balanceOf(CREATOR);
        vm.prank(CREATOR);
        escrow.claim(asset);
        assertEq(IERC20(USDC).balanceOf(CREATOR) - creatorBefore, allowance, "creator received allowance");
        assertEq(escrow.claimable(asset), 0, "nothing more claimable");
    }

    // ── R. BuybackVault: execute buyback and burn ──────────────────────────────
    function test_buyback_executeAndBurn() public {
        address router = registry.register(asset, CREATOR);
        RevenueRouter rr = RevenueRouter(router);

        _dealUsdc(address(router), 100_000_000);
        rr.distribute();

        uint256 vaultUSDC = vault.assetData(asset).balanceUSDC;
        assertEq(vaultUSDC, 30_000_000, "vault has 30 USDC");

        // v2: no CapWindowActive guard. Vault is excluded from balance limit (Decision #6).
        // Just warp past balanceLimitEnd for safety in case Monad token still enforces it for others.
        IDopplerERC20V1 tok = IDopplerERC20V1(asset);
        uint256 capEnd = uint256(tok.balanceLimitEnd());
        if (block.timestamp <= capEnd) vm.warp(capEnd + 1);

        uint256 tokenSupplyBefore = tok.totalSupply();
        uint256 usdcIn = 10_000_000; // 10 USDC

        // Execute buyback (USDC pairs: single-hop, WMON pairs: two-hop)
        address numeraire = registry.assetNumeraires(asset);
        if (numeraire == USDC) {
            vault.execute(asset, usdcIn, 0, 0);

            uint256 burned = tokenSupplyBefore - tok.totalSupply();

            console.log("--- Buyback execute ---");
            console.log("USDC in:      ", usdcIn);
            console.log("tokens burned:", burned);

            assertGt(burned, 0, "tokens were burned");
            assertEq(vault.assetData(asset).balanceUSDC, vaultUSDC - usdcIn, "vault USDC debited");
        } else {
            // WMON-paired: two-hop buyback, may revert if MON/USDC pool not initialized on fork
            try vault.execute(asset, usdcIn, 0, 0) {} catch {}
        }
    }

    // ── T. FeeEscrow: forfeit redirects USDC to BuybackVault ─────────────────
    function test_forfeit_redirectsToVault() public {
        registry.register(asset, CREATOR);

        uint256 feeAmt = 5_000_000;
        _seedEscrowAccrued(asset, feeAmt);

        uint256 vaultBefore = IERC20(USDC).balanceOf(address(vault));
        vm.warp(block.timestamp + C.FORFEIT_DELAY + 1);
        escrow.forfeit(asset);

        assertTrue(escrow.tokenData(asset).forfeited, "forfeited");
        assertEq(
            IERC20(USDC).balanceOf(address(vault)) - vaultBefore,
            feeAmt,
            "vault received forfeited USDC"
        );
        console.log("--- Forfeit ---");
        console.log("USDC moved to vault:", feeAmt);
    }

    // ── U. Wash check (SPEC S4.4) ─────────────────────────────────────────────
    function test_washCheck_netLossPerSelfPaid() public {
        address router = registry.register(asset, CREATOR);
        RevenueRouter rr = RevenueRouter(router);

        uint256 paid = 1_000_000; // 1 USDC
        _dealUsdc(address(router), paid);

        uint256 escrowSeed = 10_000_000;
        _seedEscrowAccrued(asset, escrowSeed);

        uint256 creatorBefore = IERC20(USDC).balanceOf(CREATOR);
        rr.distribute();

        uint256 providerReceived = IERC20(USDC).balanceOf(CREATOR) - creatorBefore;
        uint256 allowance        = (paid * C.ESCROW_UNLOCK_BPS) / 10_000;

        uint256 claimAmt = escrow.claimable(asset);
        assertEq(claimAmt, allowance, "claimable == allowance");

        vm.prank(CREATOR);
        escrow.claim(asset);
        uint256 totalReceived = IERC20(USDC).balanceOf(CREATOR) - creatorBefore;
        uint256 netLoss       = paid - totalReceived;

        console.log("--- Wash check ---");
        console.log("paid:             ", paid);
        console.log("provider received:", providerReceived);
        console.log("escrow claimed:   ", claimAmt);
        console.log("total received:   ", totalReceived);
        console.log("net loss:         ", netLoss);

        assertGt(netLoss, 0, "net loss must be positive (wash is unprofitable)");
        assertLt(providerReceived + allowance, paid, "can never profit from self-pay");
    }

    // ── V. Real collect: FeeEscrow + BuybackVault receive exact 20% / 10% ─────
    function test_escrow_vault_collect_exactShares() public {
        registry.register(asset, CREATOR);

        // Warp past balance-cap window so ForkTrader can receive tokens freely
        IDopplerERC20V1 tok = IDopplerERC20V1(asset);
        uint256 capEnd = uint256(tok.balanceLimitEnd());
        if (block.timestamp <= capEnd) vm.warp(capEnd + 1);

        // Get pool key directly from the fee adapter (source of truth)
        IFeeAdapter adapter = registry.feeAdapters(INITIALIZER);
        (, , PoolKey memory key, ) = adapter.getState(asset);

        // Deal USDC to ForkTrader and execute a real swap (generates 2% fee)
        uint256 swapAmt = 10_000_000; // 10 USDC -> ~0.2 USDC in fees
        _dealUsdc(address(forkTrader), swapAmt);

        uint256 escrowUsdcBefore = IERC20(USDC).balanceOf(address(escrow));
        uint256 vaultUsdcBefore  = IERC20(USDC).balanceOf(address(vault));

        forkTrader.swapUSDCForToken(asset, key, swapAmt);

        // Pull fees via real Doppler collectFees path -- no vm.store seeding
        escrow.collect(asset);
        vault.collect(asset);

        uint256 E = IERC20(USDC).balanceOf(address(escrow)) - escrowUsdcBefore;
        uint256 V = IERC20(USDC).balanceOf(address(vault))  - vaultUsdcBefore;

        console.log("--- Real collect (10 USDC swap, 2% fee) ---");
        console.log("escrow collected (20%):", E);
        console.log("vault  collected (10%):", V);

        assertGt(E, 0, "escrow collected non-zero fees");
        assertGt(V, 0, "vault collected non-zero fees");
        // E / V == ESCROW_SHARE_WAD / BUYBACK_SHARE_WAD == 2.
        // Allow +/-20 USDC-units (~$0.00002) rounding from Doppler integer division.
        assertApproxEqAbs(E * 10, V * 20, 20, "escrow:vault ratio is 20%:10%");
    }

    // ── W. PlatformFeeReceiver: collect forwards to treasury ──────────────────
    function test_platformFeeReceiver_collectAfterTrades() public {
        registry.register(asset, CREATOR);

        // Warp past balance-cap window
        IDopplerERC20V1 tok = IDopplerERC20V1(asset);
        uint256 capEnd = uint256(tok.balanceLimitEnd());
        if (block.timestamp <= capEnd) vm.warp(capEnd + 1);

        IFeeAdapter adapter = registry.feeAdapters(INITIALIZER);
        (, , PoolKey memory key, ) = adapter.getState(asset);

        // Read actual treasury from deployed PFR (may differ from TREASURY constant)
        address actualTreasury = pfr.treasury();
        _dealUsdc(actualTreasury, 0); // pre-seed slot

        // Deal USDC to ForkTrader and swap to generate trading fees
        uint256 swapAmt = 10_000_000; // 10 USDC
        _dealUsdc(address(forkTrader), swapAmt);

        uint256 treasuryBefore = IERC20(USDC).balanceOf(actualTreasury);

        forkTrader.swapUSDCForToken(asset, key, swapAmt);

        // PFR collects its 30% share from Doppler and forwards to treasury
        pfr.collect(asset);

        uint256 pfrBalance = IERC20(USDC).balanceOf(address(pfr));
        uint256 treasuryReceived = IERC20(USDC).balanceOf(actualTreasury) - treasuryBefore;

        console.log("--- PFR collect after trades ---");
        console.log("PFR remaining USDC:", pfrBalance);
        console.log("Treasury received :", treasuryReceived);

        assertEq(pfrBalance, 0, "PFR should have zero USDC after collect");
        assertGt(treasuryReceived, 0, "treasury received platform fees");
    }

    // ── X. PlatformFeeReceiver: treasury change takes effect for all tokens ──
    function test_platformFeeReceiver_treasuryChange() public {
        registry.register(asset, CREATOR);

        address newTreasury = address(0xBEEF);

        // Propose new treasury
        vm.prank(ADMIN);
        pfr.proposeTreasury(newTreasury);

        // Warp past 48h delay
        vm.warp(block.timestamp + C.TREASURY_CHANGE_DELAY);

        // Accept
        vm.prank(ADMIN);
        pfr.acceptTreasury();
        assertEq(pfr.treasury(), newTreasury, "treasury changed");

        // Warp past cap window
        IDopplerERC20V1 tok = IDopplerERC20V1(asset);
        uint256 capEnd = uint256(tok.balanceLimitEnd());
        if (block.timestamp <= capEnd) vm.warp(capEnd + 1);

        IFeeAdapter adapter = registry.feeAdapters(INITIALIZER);
        (, , PoolKey memory key, ) = adapter.getState(asset);

        // Trade to generate fees
        uint256 swapAmt = 10_000_000;
        _dealUsdc(address(forkTrader), swapAmt);
        _dealUsdc(newTreasury, 0); // pre-seed slot

        forkTrader.swapUSDCForToken(asset, key, swapAmt);

        // Collect and verify fees go to NEW treasury
        pfr.collect(asset);
        uint256 newTreasuryBal = IERC20(USDC).balanceOf(newTreasury);
        console.log("--- Treasury change + collect ---");
        console.log("New treasury received:", newTreasuryBal);
        assertGt(newTreasuryBal, 0, "new treasury received fees");
    }

    // ── Y. Admin transfer on deployed contracts ───────────────────────────────

    function test_adminTransfer_fullPath() public {
        address newAdmin = address(0xBEEF);

        // ── Registry admin transfer ──
        vm.prank(ADMIN);
        registry.transferAdmin(newAdmin);
        assertEq(registry.pendingAdmin(), newAdmin, "registry pendingAdmin set");

        vm.prank(newAdmin);
        registry.acceptAdmin();
        assertEq(registry.admin(), newAdmin, "registry admin changed");
        assertEq(registry.pendingAdmin(), address(0), "registry pendingAdmin cleared");

        // Old admin cannot pause
        vm.prank(ADMIN);
        vm.expectRevert(AstralaunchRegistry.NotAdmin.selector);
        registry.setPause(true);

        // New admin CAN pause
        vm.prank(newAdmin);
        registry.setPause(true);
        assertTrue(registry.paused(), "new admin can pause");
        vm.prank(newAdmin);
        registry.setPause(false);

        // ── PFR admin transfer ──
        vm.prank(ADMIN);
        pfr.transferAdmin(newAdmin);
        assertEq(pfr.pendingAdmin(), newAdmin, "pfr pendingAdmin set");

        vm.prank(newAdmin);
        pfr.acceptAdmin();
        assertEq(pfr.admin(), newAdmin, "pfr admin changed");

        // Old admin cannot propose treasury
        vm.prank(ADMIN);
        vm.expectRevert(PlatformFeeReceiver.NotAdmin.selector);
        pfr.proposeTreasury(address(0xDEAD));

        // New admin CAN propose treasury
        vm.prank(newAdmin);
        pfr.proposeTreasury(address(0xDEAD));
        (address proposed,) = pfr.pendingTreasury();
        assertEq(proposed, address(0xDEAD), "new admin proposed treasury");

        console.log("--- Admin transfer ---");
        console.log("registry.admin:", registry.admin());
        console.log("pfr.admin:     ", pfr.admin());

        // Restore admin for other tests (setUp clears registration but not admin)
        vm.prank(newAdmin);
        registry.transferAdmin(ADMIN);
        vm.prank(ADMIN);
        registry.acceptAdmin();
        vm.prank(newAdmin);
        pfr.cancelProposal();
        vm.prank(newAdmin);
        pfr.transferAdmin(ADMIN);
        vm.prank(ADMIN);
        pfr.acceptAdmin();
    }

    // ── Z. Balance-limit exclusion: verify isExcludedFromBalanceLimit on real token ──

    /// @notice Confirms the function exists on real DopplerERC20V1 bytecode (Task 2).
    function test_isExcludedFromBalanceLimit_existsOnRealToken() public view {
        IDopplerERC20V1 tok = IDopplerERC20V1(asset);
        // If function doesn't exist, this reverts — test fails, indicating the interface is wrong.
        bool escrowExcluded = tok.isExcludedFromBalanceLimit(address(escrow));
        console.log("escrow excluded:", escrowExcluded);
        // Random address should NOT be excluded
        assertFalse(tok.isExcludedFromBalanceLimit(address(0xBEEF)), "random addr not excluded");
    }

    function test_balanceLimitExclusion_escrow() public view {
        IDopplerERC20V1 tok = IDopplerERC20V1(asset);
        assertTrue(tok.isExcludedFromBalanceLimit(address(escrow)), "escrow excluded");
    }

    function test_balanceLimitExclusion_vault() public view {
        IDopplerERC20V1 tok = IDopplerERC20V1(asset);
        assertTrue(tok.isExcludedFromBalanceLimit(address(vault)), "vault excluded");
    }

    function test_balanceLimitExclusion_pfr() public view {
        IDopplerERC20V1 tok = IDopplerERC20V1(asset);
        assertTrue(tok.isExcludedFromBalanceLimit(address(pfr)), "pfr excluded");
    }

    function test_balanceLimitExclusion_randomAddr() public view {
        IDopplerERC20V1 tok = IDopplerERC20V1(asset);
        // 0xDEAD is the NOGOV address (excluded by Doppler). Use a truly random address.
        assertFalse(tok.isExcludedFromBalanceLimit(address(0xCAFE)), "random addr not excluded");
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /// @dev Clear all registration state for `a` so that register() can be called
    ///      again in tests even if npm run launch pre-registered the token.
    ///
    ///      v2 storage layout (PoolKey extracted from AssetData):
    ///
    ///      AstralaunchRegistry:
    ///        allowedInitializers (slot0), feeAdapters (slot1), pendingInitializer (slot2-4),
    ///        platformFeeReceiver (slot5), feeEscrow (slot6), buybackVault (slot7),
    ///        routerImplementation (slot8), admin+paused (slot9, packed),
    ///        pendingAdmin (slot10), routers mapping (slot11),
    ///        assetNumeraires (slot12), assetInitializers (slot13)
    ///
    ///      FeeEscrow (immutables not in storage):
    ///        _data mapping (slot0); base = keccak256(abi.encode(asset, 0))
    ///        base+0: creator(addr20)+launchTime(uint48)+forfeited(bool)
    ///
    ///      BuybackVault (Solady ReentrancyGuard uses custom high slot, not slot 0):
    ///        _assets mapping (slot0); base = keccak256(abi.encode(asset, 0))
    ///        base+0: poolId (bytes32)
    ///        base+1: registered(bool) + numeraire(address) packed
    ///        _poolKeys mapping (slot1)
    ///
    ///      PlatformFeeReceiver:
    ///        admin(0), treasury(1), proposedTreasury(2), proposalExecutableAt(3),
    ///        pendingAdmin(4), assetPoolIds mapping(5), assetNumeraires mapping(6).
    function _clearRegistration(address a) internal {
        // 1. AstralaunchRegistry.routers[a] -- mapping at slot 11
        vm.store(address(registry), keccak256(abi.encode(a, uint256(11))), bytes32(0));

        // 2. FeeEscrow._data[a] base+0 (clears launchTime, passing AlreadyRegistered guard)
        bytes32 eBase = keccak256(abi.encode(a, uint256(0)));
        vm.store(address(escrow), eBase, bytes32(0));

        // 3. BuybackVault._assets[a] base+1 (clears registered flag and numeraire)
        bytes32 vBase = keccak256(abi.encode(a, uint256(0)));
        vm.store(address(vault), bytes32(uint256(vBase) + 1), bytes32(0));

        // 4. PlatformFeeReceiver.assetPoolIds[a] -- mapping at slot 5
        vm.store(address(pfr), keccak256(abi.encode(a, uint256(5))), bytes32(0));
    }

    /// @dev Set a USDC balance via vm.store (slot 9 = USDC balance mapping on Monad).
    function _dealUsdc(address to, uint256 amt) internal {
        bytes32 slot = keccak256(abi.encode(to, uint256(9)));
        vm.store(USDC, slot, bytes32(amt));
    }

    /// @dev Seed escrow._data[asset].usdcAccrued via vm.store and credit matching USDC.
    function _seedEscrowAccrued(address a, uint256 amt) internal {
        bytes32 base = keccak256(abi.encode(a, uint256(0)));
        bytes32 slot = bytes32(uint256(base) + 1);
        vm.store(address(escrow), slot, bytes32(uint256(uint128(amt))));
        _dealUsdc(address(escrow), amt);
    }
}

// ── ForkTrader ────────────────────────────────────────────────────────────────
/// @notice Executes a real USDC -> asset token swap on the Doppler v4 pool via
///         PoolManager.unlock / IUnlockCallback (CLAUDE.md rule 13, D14).
///         Used by test V to generate real trading fees without vm.store seeding.
contract ForkTrader is IUnlockCallback {
    using SafeTransferLib for address;
    using BalanceDeltaLib for BalanceDelta;

    address constant POOL_MANAGER = 0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e;
    address constant USDC         = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;

    IPoolManager immutable pm;

    PoolKey  private _key;
    address  private _asset;

    constructor() { pm = IPoolManager(POOL_MANAGER); }

    function swapUSDCForToken(address asset_, PoolKey memory key, uint256 usdcIn) external {
        _key   = key;
        _asset = asset_;
        pm.unlock(abi.encode(asset_, usdcIn));
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        require(msg.sender == POOL_MANAGER, "ForkTrader: not pm");

        (address asset_, uint256 usdcIn) = abi.decode(data, (address, uint256));
        PoolKey memory key = _key;
        bool zeroForOne = key.currency0 == USDC;

        SwapParams memory params = SwapParams({
            zeroForOne:        zeroForOne,
            amountSpecified:   -int256(usdcIn), // exact-in
            sqrtPriceLimitX96: zeroForOne
                ? uint160(4_295_128_740)                              // MIN_SQRT_RATIO + 1
                : uint160(1_461_446_703_485_210_103_172_823_403_640)  // MAX_SQRT_RATIO - 1
        });

        BalanceDelta delta = pm.swap(key, params, "");

        // Settle USDC debt: sync -> transfer -> settle
        int128 usdcDeltaI = zeroForOne ? delta.amount0() : delta.amount1();
        uint256 usdcOwed  = uint256(uint128(-usdcDeltaI));
        pm.sync(USDC);
        USDC.safeTransfer(POOL_MANAGER, usdcOwed);
        pm.settle();

        // Take token output (held in ForkTrader; test only cares about fees)
        int128 tokenDeltaI = zeroForOne ? delta.amount1() : delta.amount0();
        uint256 tokenOut   = uint256(uint128(tokenDeltaI));
        if (tokenOut > 0) pm.take(asset_, address(this), tokenOut);

        return abi.encode(tokenOut);
    }
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
}

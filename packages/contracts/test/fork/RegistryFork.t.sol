// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {FeeEscrow} from "../../src/FeeEscrow.sol";
import {BuybackVault} from "../../src/BuybackVault.sol";
import {RevenueRouter} from "../../src/RevenueRouter.sol";
import {RevpadRegistry} from "../../src/RevpadRegistry.sol";
import {RevpadConstants as C} from "../../src/RevpadConstants.sol";
import {PoolKey, IInitializer} from "../../src/interfaces/IInitializer.sol";
import {IPoolManager, IUnlockCallback, SwapParams, BalanceDelta, BalanceDeltaLib} from "../../src/interfaces/IPoolManager.sol";
import {IDopplerERC20V1} from "../../src/interfaces/IDopplerERC20V1.sol";
import {IAirlock} from "../../src/interfaces/IAirlock.sol";

/// @notice Fork tests against Monad mainnet state (Anvil fork at http://127.0.0.1:8545).
///
///         Required setup:
///           1. anvil/start-fork.sh
///           2. forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 \
///                --broadcast --private-key $PRIVATE_KEY
///              (writes ../../revpad-anvil/.anvil-state/contracts.json)
///           3. npm run launch  (launches test token)
///
///         Run:
///           forge test --match-path "test/fork/**" --fork-url http://127.0.0.1:8545 -vv
///
///         Optional env vars:
///           CONTRACTS_JSON_PATH  — path to contracts.json  (default in foundry.toml constant)
///           FORK_ASSET           — token address from launch step
///
/// @dev Deploys fresh contracts in setUp so constructors and all immutables are exercised.
///      Deploy.s.sol writes contracts.json with the deployer's nonce; setUp reads it so
///      the hardcoded nonce "633" is no longer embedded in this file.
///      Falls back to ADMIN-nonce-633 defaults when the JSON is absent.
contract RegistryForkTest is Test {
    using SafeTransferLib for address;
    using BalanceDeltaLib for BalanceDelta;

    // ── Monad mainnet constants ────────────────────────────────────────────────
    address constant POOL_MANAGER = 0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e;
    address constant INITIALIZER  = 0xCe3099B2F07029b086E5e92a1573C5f5A3071783;
    address constant AIRLOCK      = 0x660eAaEdEBc968f8f3694354FA8EC0b4c5Ba8D12;
    address constant USDC         = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address constant NOMIG        = 0x5F3bA43D44375286296Cb85F1EA2EBfa25dde731;
    address constant NOGOV        = 0x000000000000000000000000000000000000dEaD;

    // Anvil default accounts
    address constant ADMIN    = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    address constant CREATOR  = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    address constant TREASURY = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;

    // Hardcoded fallback addresses for ADMIN nonce 633..636.
    // Used when CONTRACTS_JSON_PATH env var is not set (or JSON absent).
    address constant DEFAULT_ESCROW    = 0x3C2BafebbB0c8c58f39A976e725cD20D611d01e9;
    address constant DEFAULT_VAULT     = 0x5f246ADDCF057E0f778CD422e20e413be70f9a0c;
    address constant DEFAULT_REGISTRY  = 0x4Dd5336F3C0D70893A7a86c6aEBe9B953E87c891;

    // Path Deploy.s.sol writes; foundry.toml grants read-write for this prefix.
    string constant CONTRACTS_JSON_DEFAULT = "../../revpad-anvil/.anvil-state/contracts.json";

    FeeEscrow      escrow;
    BuybackVault   vault;
    RevpadRegistry registry;
    ForkTrader     forkTrader;

    address deployer; // set in setUp from JSON or ADMIN fallback
    address asset;

    function setUp() public {
        // ── Resolve deployed addresses ─────────────────────────────────────────
        // Read contracts.json written by Deploy.s.sol (startNonce is no longer hardcoded).
        // If the JSON is absent, fall back to ADMIN / nonce 633 constants.
        uint256 startNonce;
        address escrowAddr;
        address vaultAddr;
        address routerImplAddr;
        address registryAddr;

        string memory jsonPath = vm.envOr("CONTRACTS_JSON_PATH", CONTRACTS_JSON_DEFAULT);
        bool parsed = false;
        if (bytes(jsonPath).length > 0) {
            try vm.readFile(jsonPath) returns (string memory json) {
                deployer       = vm.parseJsonAddress(json, ".deployer");
                startNonce     = vm.parseJsonUint(json,    ".deployerStartNonce");
                escrowAddr     = vm.parseJsonAddress(json, ".escrow");
                vaultAddr      = vm.parseJsonAddress(json, ".vault");
                routerImplAddr = vm.parseJsonAddress(json, ".routerImpl");
                registryAddr   = vm.parseJsonAddress(json, ".registry");
                parsed = true;
            } catch { /* fall through to defaults */ }
        }
        if (!parsed) {
            deployer       = ADMIN;
            startNonce     = 633;
            escrowAddr     = DEFAULT_ESCROW;
            vaultAddr      = DEFAULT_VAULT;
            routerImplAddr = vm.computeCreateAddress(ADMIN, 635);
            registryAddr   = DEFAULT_REGISTRY;
        }

        // ── Fresh deploy at original addresses (no vm.etch swap trick) ──────────
        // Clears existing bytecode then deploys with new so constructors run and
        // all immutable fields are properly set.  Fixes the vm.etch approach that
        // would zero every immutable (see docs/CONTRACTS-REVIEW.md §7).
        vm.etch(escrowAddr,    new bytes(0));
        vm.etch(vaultAddr,     new bytes(0));
        vm.etch(routerImplAddr,new bytes(0));
        vm.etch(registryAddr,  new bytes(0));
        vm.setNonce(escrowAddr,    0);
        vm.setNonce(vaultAddr,     0);
        vm.setNonce(routerImplAddr,0);
        vm.setNonce(registryAddr,  0);

        vm.setNonce(deployer, uint64(startNonce)); // nonce from JSON, not hardcoded

        address futureVault    = vm.computeCreateAddress(deployer, startNonce + 1);
        address futureRegistry = vm.computeCreateAddress(deployer, startNonce + 3);

        vm.startPrank(deployer);
        escrow   = new FeeEscrow(futureRegistry, futureVault, INITIALIZER);         // N+0
        vault    = new BuybackVault(futureRegistry, INITIALIZER, POOL_MANAGER);    // N+1
        new RevenueRouter();                                                         // N+2
        registry = new RevpadRegistry(
            TREASURY, address(escrow), address(vault), routerImplAddr, deployer
        );                                                                           // N+3
        vm.stopPrank();

        require(address(escrow)   == escrowAddr,    "escrow addr mismatch");
        require(address(vault)    == vaultAddr,      "vault addr mismatch");
        require(address(registry) == registryAddr,   "registry addr mismatch");

        // Verify all immutables are properly wired
        assertEq(escrow.registry(),            address(registry), "escrow.registry");
        assertEq(escrow.buybackVault(),         address(vault),    "escrow.buybackVault");
        assertEq(vault.registry(),             address(registry), "vault.registry");
        assertEq(address(vault.poolManager()), POOL_MANAGER,      "vault.poolManager");

        asset      = vm.envOr("FORK_ASSET",
            address(0xad50518E1Dd6CA5B7491eEBa27e1fCb9a4BAc407));
        forkTrader = new ForkTrader();
    }

    // ── A. Deployment sanity ──────────────────────────────────────────────────
    function test_deploy_addresses() public view {
        assertEq(registry.treasury(),              TREASURY);
        assertEq(registry.admin(),                 deployer);
        assertEq(address(registry.feeEscrow()),    address(escrow));
        assertEq(address(registry.buybackVault()), address(vault));
    }

    /// @notice Verify every cross-contract immutable is non-zero and points at the right peer.
    ///         This is the deploy-script regression test: the original Deploy.s.sol passed
    ///         address(0) as FeeEscrow.buybackVault (see docs/CONTRACTS-REVIEW.md §7).
    function test_deploy_immutablesWiredCorrectly() public view {
        assertEq(escrow.buybackVault(),           address(vault),    "escrow.buybackVault != vault");
        assertEq(escrow.registry(),               address(registry), "escrow.registry != registry");
        assertEq(vault.registry(),                address(registry), "vault.registry != registry");
        assertNotEq(address(vault.poolManager()), address(0),        "vault.poolManager is zero");
        assertNotEq(address(vault.initializer()), address(0),        "vault.initializer is zero");
        assertNotEq(address(escrow.initializer()),address(0),        "escrow.initializer is zero");
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
        assertEq(rr.treasury(),     TREASURY);

        FeeEscrow.TokenData memory td = escrow.tokenData(asset);
        assertEq(td.creator, CREATOR);
        assertFalse(td.forfeited);
    }

    // ── C. register: rejects wrong pool (hook mismatch) ───────────────────────
    function test_register_revertsWrongPool() public {
        PoolKey memory badKey = PoolKey({
            currency0: USDC,
            currency1: asset,
            fee: C.POOL_FEE,
            tickSpacing: C.TICK_SPACING,
            hooks: address(0)
        });
        vm.mockCall(
            INITIALIZER,
            abi.encodeWithSelector(IInitializer.getState.selector, asset),
            abi.encode(USDC, uint8(1), badKey, int24(-887200))
        );
        vm.expectRevert(RevpadRegistry.WrongPool.selector);
        registry.register(asset, CREATOR);
    }

    // ── D. register: rejects wrong creator (share mismatch) ───────────────────
    function test_register_revertsWrongCreator() public {
        address fakeCreator = address(0xBAD);
        vm.expectRevert(abi.encodeWithSelector(
            RevpadRegistry.WrongCreatorShare.selector, uint256(0), C.CREATOR_SHARE_WAD
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
            RevpadRegistry.WrongIntegrator.selector, wrongIntegrator, TREASURY
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
            RevpadRegistry.WrongVestingAmount.selector, badAmount, C.VESTED_TOKENS_NUM
        ));
        registry.register(asset, CREATOR);
    }

    // ── G. register: rejects wrong balance cap (5 % instead of 1 %) ──────────
    function test_register_revertsWrongBalanceCap_fivePct() public {
        uint256 badCap = C.TOTAL_SUPPLY / 20;
        vm.mockCall(
            asset,
            abi.encodeWithSelector(IDopplerERC20V1.maxBalanceLimit.selector),
            abi.encode(badCap)
        );
        vm.expectRevert(abi.encodeWithSelector(
            RevpadRegistry.WrongBalanceCap.selector, badCap, C.BALANCE_CAP_NUM
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
            RevpadRegistry.WrongBalanceCap.selector, uint256(0), C.BALANCE_CAP_WINDOW
        ));
        registry.register(asset, CREATOR);
    }

    // ── K. register: duplicate reverts ───────────────────────────────────────
    function test_register_revertsOnDuplicate() public {
        registry.register(asset, CREATOR);
        vm.expectRevert(RevpadRegistry.AlreadyRegistered.selector);
        registry.register(asset, CREATOR);
    }

    // ── P. Revenue path: distribute() splits exactly 60/30/10 ────────────────
    function test_revenuePath_exactSplits() public {
        address router = registry.register(asset, CREATOR);
        RevenueRouter rr = RevenueRouter(router);

        uint256 total = 10_000_000; // 10 USDC
        deal(USDC, address(rr), total);

        uint256 creatorBefore  = IERC20(USDC).balanceOf(CREATOR);
        uint256 treasuryBefore = IERC20(USDC).balanceOf(TREASURY);

        rr.distribute();

        uint256 providerExpected = (total * C.PROVIDER_BPS) / 10_000; // 6_000_000
        uint256 buybackExpected  = (total * C.BUYBACK_BPS)  / 10_000; // 3_000_000
        uint256 treasuryExpected = (total * C.TREASURY_BPS) / 10_000; // 1_000_000

        console.log("--- Revenue split (10 USDC in) ---");
        console.log("provider (60%):", providerExpected);
        console.log("buyback  (30%):", buybackExpected);
        console.log("treasury (10%):", treasuryExpected);

        assertEq(IERC20(USDC).balanceOf(CREATOR)  - creatorBefore,  providerExpected, "provider");
        assertEq(IERC20(USDC).balanceOf(TREASURY) - treasuryBefore, treasuryExpected, "treasury");
        assertEq(vault.assetData(asset).balanceUSDC,      buybackExpected, "vault USDC");
        assertEq(escrow.tokenData(asset).recordedRevenue, total,           "recordedRevenue");
    }

    // ── Q. Escrow: full claim path ─────────────────────────────────────────────
    function test_escrowClaim_fullPath() public {
        address router = registry.register(asset, CREATOR);
        RevenueRouter rr = RevenueRouter(router);

        // Record 100 USDC service revenue via distribute()
        uint256 revenue = 100_000_000; // 100 USDC
        deal(USDC, address(router), revenue);
        rr.distribute();
        // allowance = 100 USDC × 20% = 20 USDC

        // Simulate 50 USDC of trading fees via storage seeding
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

    // ── R. BuybackVault: execute buyback and burn after cap window ────────────
    function test_buyback_executeAndBurn() public {
        address router = registry.register(asset, CREATOR);
        RevenueRouter rr = RevenueRouter(router);

        deal(USDC, address(router), 100_000_000);
        rr.distribute();

        uint256 vaultUSDC = vault.assetData(asset).balanceUSDC;
        assertEq(vaultUSDC, 30_000_000, "vault has 30 USDC");

        // Warp past balanceLimitEnd so DopplerERC20V1 balance cap is lifted
        IDopplerERC20V1 tok = IDopplerERC20V1(asset);
        vm.warp(uint256(tok.balanceLimitEnd()) + 1);

        uint256 tokenSupplyBefore = tok.totalSupply();
        uint256 usdcIn = 10_000_000; // 10 USDC

        vault.execute(asset, usdcIn, 0);

        uint256 burned = tokenSupplyBefore - tok.totalSupply();

        console.log("--- Buyback execute (after cap window) ---");
        console.log("USDC in:      ", usdcIn);
        console.log("tokens burned:", burned);

        assertGt(burned, 0, "tokens were burned");
        assertEq(vault.assetData(asset).balanceUSDC, vaultUSDC - usdcIn, "vault USDC debited");
    }

    // ── S. BuybackVault: execute() reverts during balance cap window ──────────
    /// @notice At launch price (~$0.00001/token), even 0.1 USDC buys ≥ 1% of supply.
    ///         The vault's own balance would exceed the DopplerERC20V1 balance cap on
    ///         token receipt, causing a cryptic ERC-20 revert inside the swap callback.
    ///         BuybackVault.execute() now guards this with CapWindowActive.
    ///         Documented in SPEC §6.4 and decisions.md D19.
    function test_buyback_revertsInCapWindow() public {
        address router = registry.register(asset, CREATOR);
        RevenueRouter rr = RevenueRouter(router);

        deal(USDC, address(rr), 100_000_000);
        rr.distribute(); // vault gets 30 USDC

        // Force balanceLimitEnd into the future regardless of current block.timestamp
        vm.mockCall(
            asset,
            abi.encodeWithSelector(IDopplerERC20V1.balanceLimitEnd.selector),
            abi.encode(uint48(block.timestamp + 9_999))
        );

        vm.expectRevert(BuybackVault.CapWindowActive.selector);
        vault.execute(asset, 1_000_000, 0);
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

    // ── U. Wash check (SPEC §4.4) ─────────────────────────────────────────────
    function test_washCheck_netLossPerSelfPaid() public {
        address router = registry.register(asset, CREATOR);
        RevenueRouter rr = RevenueRouter(router);

        uint256 paid = 1_000_000; // 1 USDC
        deal(USDC, address(router), paid);

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
    /// @notice ForkTrader executes a real USDC→token swap on the Doppler pool to
    ///         generate actual trading fees.  Then escrow.collect() and vault.collect()
    ///         pull their shares via the real Doppler collectFees path (no vm.store).
    ///         Asserts escrow : vault ratio == 20% : 10% == 2 : 1 (±1 USDC-unit rounding).
    ///         Requires the pool to be in the SELLING phase and block.timestamp > balanceLimitEnd.
    function test_escrow_vault_collect_exactShares() public {
        registry.register(asset, CREATOR);

        // Warp past the balance-cap window so ForkTrader can receive tokens freely
        IDopplerERC20V1 tok = IDopplerERC20V1(asset);
        vm.warp(uint256(tok.balanceLimitEnd()) + 1);

        // Get pool key from the initializer (avoids hardcoding which currency is currency0)
        (, , PoolKey memory key, ) = IInitializer(INITIALIZER).getState(asset);

        // Deal USDC to ForkTrader and execute a real swap (generates 2% fee in USDC)
        uint256 swapAmt = 10_000_000; // 10 USDC → ~0.2 USDC in fees
        deal(USDC, address(forkTrader), swapAmt);

        uint256 escrowUsdcBefore = IERC20(USDC).balanceOf(address(escrow));
        uint256 vaultUsdcBefore  = IERC20(USDC).balanceOf(address(vault));

        forkTrader.swapUSDCForToken(asset, key, swapAmt);

        // Pull fees via real Doppler collectFees — no vm.store seeding
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
        // Allow ±20 USDC-units (~$0.00002) rounding from Doppler integer division.
        assertApproxEqAbs(E * 10, V * 20, 20, "escrow:vault ratio is 20%:10%");
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /// @dev Seed escrow._data[asset].usdcAccrued via vm.store and deal matching USDC.
    ///      Use only when testing the escrow claim/forfeit logic independent of real trades.
    ///      Storage: _data is mapping at slot 0.
    ///      _data[asset] base = keccak256(abi.encode(asset, uint256(0))).
    ///      Slot base+1 = packed { usdcAccrued uint128 (low bits), usdcClaimed uint128 (high) }.
    function _seedEscrowAccrued(address a, uint256 amt) internal {
        bytes32 base = keccak256(abi.encode(a, uint256(0)));
        bytes32 slot = bytes32(uint256(base) + 1);
        vm.store(address(escrow), slot, bytes32(uint256(uint128(amt))));
        deal(USDC, address(escrow), amt);
    }
}

// ── ForkTrader ────────────────────────────────────────────────────────────────
/// @notice Executes a real USDC → asset token swap on the Doppler v4 pool via
///         PoolManager.unlock / IUnlockCallback (CLAUDE.md rule 13, D14).
///         Used in fork tests to generate real trading fees without vm.store seeding.
///         Mirror of BuybackVault's swap path; kept minimal (no burn, just take tokens).
contract ForkTrader is IUnlockCallback {
    using SafeTransferLib for address;
    using BalanceDeltaLib for BalanceDelta;

    address constant POOL_MANAGER = 0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e;
    address constant USDC         = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;

    IPoolManager immutable pm;

    // Transient swap context (set before pm.unlock, consumed in unlockCallback)
    PoolKey  private _key;
    address  private _asset;

    constructor() { pm = IPoolManager(POOL_MANAGER); }

    /// @notice Swap `usdcIn` USDC for asset tokens using the pool's own PoolKey.
    ///         Caller must have dealt at least `usdcIn` USDC to this contract first.
    function swapUSDCForToken(address asset_, PoolKey memory key, uint256 usdcIn) external {
        _key   = key;
        _asset = asset_;
        pm.unlock(abi.encode(asset_, usdcIn));
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        require(msg.sender == POOL_MANAGER, "ForkTrader: not pm");

        (address asset_, uint256 usdcIn) = abi.decode(data, (address, uint256));
        PoolKey memory key = _key;
        bool zeroForOne    = key.currency0 == USDC; // sell USDC (whichever currency it is)

        SwapParams memory params = SwapParams({
            zeroForOne:        zeroForOne,
            amountSpecified:   -int256(usdcIn), // exact-in
            sqrtPriceLimitX96: zeroForOne
                ? uint160(4_295_128_740)                              // MIN_SQRT_RATIO + 1
                : uint160(1_461_446_703_485_210_103_172_823_403_640)  // MAX_SQRT_RATIO - 1
        });

        BalanceDelta delta = pm.swap(key, params, "");

        // Settle USDC debt: sync → transfer → settle (V4 ERC-20 settlement pattern)
        int128 usdcDeltaI = zeroForOne ? delta.amount0() : delta.amount1();
        uint256 usdcOwed  = uint256(uint128(-usdcDeltaI));
        pm.sync(USDC);
        USDC.safeTransfer(POOL_MANAGER, usdcOwed);
        pm.settle();

        // Take token output (held in ForkTrader — test only cares about fees, not tokens)
        int128 tokenDeltaI = zeroForOne ? delta.amount1() : delta.amount0();
        uint256 tokenOut   = uint256(uint128(tokenDeltaI));
        if (tokenOut > 0) pm.take(asset_, address(this), tokenOut);

        return abi.encode(tokenOut);
    }
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
}

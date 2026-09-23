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
///           3. npm run launch
///
///         Run:
///           CONTRACTS_JSON_PATH=../../revpad-anvil/.anvil-state/contracts.json \
///           forge test --match-path "test/fork/**" --fork-url http://127.0.0.1:8545 -vv
///
///         Required env vars:
///           CONTRACTS_JSON_PATH — path to contracts.json written by Deploy.s.sol
///           (optional) STATE_JSON_PATH — path to state.json; defaults to sibling of contracts.json
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
    address constant NOMIG        = 0x5F3bA43D44375286296Cb85F1EA2EBfa25dde731;
    address constant NOGOV        = 0x000000000000000000000000000000000000dEaD;

    // Anvil default accounts (match the mnemonic in revpad-anvil/src/env.ts)
    address constant ADMIN    = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266; // account[0]
    address constant CREATOR  = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266; // same as ADMIN
    address constant TREASURY = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8; // account[1]

    // Default JSON paths — relative to packages/contracts/ (Foundry project root).
    // fs_permissions in foundry.toml grants read access to this directory.
    string constant CONTRACTS_JSON_DEFAULT = "../../revpad-anvil/.anvil-state/contracts.json";
    string constant STATE_JSON_DEFAULT     = "../../revpad-anvil/.anvil-state/state.json";

    FeeEscrow      escrow;
    BuybackVault   vault;
    RevpadRegistry registry;
    ForkTrader     forkTrader;

    address asset; // launched token (from state.json)

    function setUp() public {
        // ── Read deployed contract addresses from contracts.json ────────────────
        // Deploy.s.sol writes this file after every broadcast.
        // No redeployment, no vm.etch, no vm.setNonce.
        string memory cPath = vm.envOr("CONTRACTS_JSON_PATH", CONTRACTS_JSON_DEFAULT);
        string memory cJson = vm.readFile(cPath);

        escrow   = FeeEscrow(vm.parseJsonAddress(cJson, ".escrow"));
        vault    = BuybackVault(vm.parseJsonAddress(cJson, ".vault"));
        registry = RevpadRegistry(vm.parseJsonAddress(cJson, ".registry"));

        // ── Read launched token from state.json ────────────────────────────────
        string memory sPath = vm.envOr("STATE_JSON_PATH", STATE_JSON_DEFAULT);
        string memory sJson = vm.readFile(sPath);
        asset = vm.parseJsonAddress(sJson, ".token");

        forkTrader = new ForkTrader();

        // ── Pre-seed USDC balance slots to avoid fork-backend fetches ─────────
        // USDC balance mapping is at slot 9 on Monad.  Test addresses have no
        // real USDC on Monad mainnet; Foundry would normally fetch the 0-value
        // slot from Anvil, which in turn proxies to the upstream RPC.  If Anvil's
        // upstream connections die (CLOSE_WAIT), these fetches time out.
        // Writing 0 locally marks the slot as "known" so no backend call is made.
        // Non-zero amounts are overwritten again in each test before they're used.
        _dealUsdc(CREATOR,          0);
        _dealUsdc(TREASURY,         0);
        _dealUsdc(address(escrow),  0);
        _dealUsdc(address(vault),   0);

        // ── Clear pre-registration from npm run launch ─────────────────────────
        // npm run launch now calls registry.register() as the final step so that
        // the asset/router are available immediately.  Fork tests each call
        // registry.register() themselves (to test the validation path or to set
        // up a fresh router), so we reset the registration state here.
        //
        // Slots cleared:
        //   registry.routers[asset]           → RevpadRegistry slot 5
        //   escrow._data[asset] (base+0)       → creator+launchTime+forfeited (clears launchTime)
        //   vault._assets[asset] (base+4)      → registered+balanceUSDC (clears registered flag)
        //
        // All revenue/accrual fields are already 0 (no trading has occurred since launch).
        _clearRegistration(asset);

    }

    // ── A. Deployment sanity ──────────────────────────────────────────────────
    function test_deploy_addresses() public view {
        assertEq(registry.treasury(),              TREASURY,          "treasury");
        assertEq(registry.admin(),                 ADMIN,             "admin");
        assertEq(address(registry.feeEscrow()),    address(escrow),   "feeEscrow");
        assertEq(address(registry.buybackVault()), address(vault),    "buybackVault");
    }

    /// @notice Verifies the Deploy.s.sol immutable wiring on the real deployed contracts.
    ///         Caught the address(0) bug (Deploy.s.sol Fix 5 / decisions.md K).
    function test_deploy_immutablesWiredCorrectly() public view {
        assertEq(escrow.buybackVault(),            address(vault),    "escrow.buybackVault");
        assertEq(escrow.registry(),                address(registry), "escrow.registry");
        assertEq(vault.registry(),                 address(registry), "vault.registry");
        assertNotEq(address(vault.poolManager()),  address(0),        "vault.poolManager");
        assertNotEq(address(vault.initializer()),  address(0),        "vault.initializer");
        assertNotEq(address(escrow.initializer()), address(0),        "escrow.initializer");
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
            hooks: address(0) // wrong hook
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

    // ── G. register: rejects wrong balance cap (5% instead of 1%) ────────────
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
        _dealUsdc(address(rr), total);

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
        _dealUsdc(address(router), revenue);
        rr.distribute();
        // allowance = 100 USDC × 20% = 20 USDC

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

    // ── R. BuybackVault: execute buyback and burn after cap window ────────────
    function test_buyback_executeAndBurn() public {
        address router = registry.register(asset, CREATOR);
        RevenueRouter rr = RevenueRouter(router);

        _dealUsdc(address(router), 100_000_000);
        rr.distribute();

        uint256 vaultUSDC = vault.assetData(asset).balanceUSDC;
        assertEq(vaultUSDC, 30_000_000, "vault has 30 USDC");

        // Warp past balanceLimitEnd so the DopplerERC20V1 balance cap is lifted
        IDopplerERC20V1 tok = IDopplerERC20V1(asset);
        uint256 capEnd = uint256(tok.balanceLimitEnd());
        if (block.timestamp <= capEnd) vm.warp(capEnd + 1);

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
    function test_buyback_revertsInCapWindow() public {
        address router = registry.register(asset, CREATOR);
        RevenueRouter rr = RevenueRouter(router);

        _dealUsdc(address(rr), 100_000_000);
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
    /// @notice ForkTrader executes a real USDC→token swap on the Doppler pool,
    ///         then escrow.collect() and vault.collect() pull via the real
    ///         Doppler collectFees path (no vm.store seeding).
    ///         Asserts escrow : vault == 20% : 10% == 2 : 1 (±20 USDC-units rounding).
    function test_escrow_vault_collect_exactShares() public {
        registry.register(asset, CREATOR);

        // Warp past balance-cap window so ForkTrader can receive tokens freely
        IDopplerERC20V1 tok = IDopplerERC20V1(asset);
        uint256 capEnd = uint256(tok.balanceLimitEnd());
        if (block.timestamp <= capEnd) vm.warp(capEnd + 1);

        // Get pool key directly from the initializer (source of truth)
        (, , PoolKey memory key, ) = IInitializer(INITIALIZER).getState(asset);

        // Deal USDC to ForkTrader and execute a real swap (generates 2% fee)
        uint256 swapAmt = 10_000_000; // 10 USDC → ~0.2 USDC in fees
        _dealUsdc(address(forkTrader), swapAmt);

        uint256 escrowUsdcBefore = IERC20(USDC).balanceOf(address(escrow));
        uint256 vaultUsdcBefore  = IERC20(USDC).balanceOf(address(vault));

        forkTrader.swapUSDCForToken(asset, key, swapAmt);

        // Pull fees via real Doppler collectFees path — no vm.store seeding
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

    /// @dev Clear all registration state for `a` so that register() can be called
    ///      again in tests even if npm run launch pre-registered the token.
    ///
    ///      Storage layout (verified against source + Solady ReentrancyGuard namespaced slot):
    ///
    ///      RevpadRegistry:
    ///        treasury (slot0), feeEscrow (slot1), buybackVault (slot2),
    ///        routerImplementation (slot3), admin+paused (slot4, packed),
    ///        routers mapping (slot5)
    ///
    ///      FeeEscrow (immutables not in storage):
    ///        _data mapping (slot0); base = keccak256(abi.encode(asset, 0))
    ///        base+0: creator(addr20)+launchTime(uint48)+forfeited(bool) — zeroing clears launchTime
    ///
    ///      BuybackVault (ReentrancyGuard uses non-sequential namespaced slot, not slot0):
    ///        _assets mapping (slot0); base = keccak256(abi.encode(asset, 0))
    ///        PoolKey fields: currency0 (base+0), currency1+fee+tickSpacing (base+1), hooks (base+2)
    ///        poolId (base+3), registered+balanceUSDC packed (base+4)
    function _clearRegistration(address a) internal {
        // 1. RevpadRegistry.routers[a]
        vm.store(address(registry), keccak256(abi.encode(a, uint256(5))), bytes32(0));

        // 2. FeeEscrow._data[a] base+0 (clears launchTime, passing AlreadyRegistered guard)
        bytes32 eBase = keccak256(abi.encode(a, uint256(0)));
        vm.store(address(escrow), eBase, bytes32(0));

        // 3. BuybackVault._assets[a] base+4 (clears registered flag and balanceUSDC)
        bytes32 vBase = keccak256(abi.encode(a, uint256(0)));
        vm.store(address(vault), bytes32(uint256(vBase) + 4), bytes32(0));
    }

    /// @dev Set a USDC balance via vm.store (slot 9 = USDC balance mapping on Monad).
    ///      Avoids StdStorage's balanceOf() probe which triggers a fork-backend fetch
    ///      for never-accessed slots and times out when Anvil's upstream connections die.
    function _dealUsdc(address to, uint256 amt) internal {
        bytes32 slot = keccak256(abi.encode(to, uint256(9)));
        vm.store(USDC, slot, bytes32(amt));
    }

    /// @dev Seed escrow._data[asset].usdcAccrued via vm.store and credit matching USDC.
    ///      Used for tests that need accrued trading fees without running real trades.
    ///      Storage: _data mapping at slot 0; base = keccak256(abi.encode(asset, 0)).
    ///      Slot base+1 low 128 bits = usdcAccrued; high 128 bits = usdcClaimed (0).
    function _seedEscrowAccrued(address a, uint256 amt) internal {
        bytes32 base = keccak256(abi.encode(a, uint256(0)));
        bytes32 slot = bytes32(uint256(base) + 1);
        vm.store(address(escrow), slot, bytes32(uint256(uint128(amt))));
        _dealUsdc(address(escrow), amt);
    }
}

// ── ForkTrader ────────────────────────────────────────────────────────────────
/// @notice Executes a real USDC → asset token swap on the Doppler v4 pool via
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
        // zeroForOne = true  when USDC is currency0 (USDC < asset)
        // zeroForOne = false when USDC is currency1 (asset < USDC) — our test token case
        bool zeroForOne = key.currency0 == USDC;

        SwapParams memory params = SwapParams({
            zeroForOne:        zeroForOne,
            amountSpecified:   -int256(usdcIn), // exact-in
            sqrtPriceLimitX96: zeroForOne
                ? uint160(4_295_128_740)                              // MIN_SQRT_RATIO + 1
                : uint160(1_461_446_703_485_210_103_172_823_403_640)  // MAX_SQRT_RATIO - 1
        });

        BalanceDelta delta = pm.swap(key, params, "");

        // Settle USDC debt: sync → transfer → settle
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

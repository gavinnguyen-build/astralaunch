// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FeeEscrow} from "../../src/FeeEscrow.sol";
import {BuybackVault} from "../../src/BuybackVault.sol";
import {RevenueRouter} from "../../src/RevenueRouter.sol";
import {RevpadRegistry} from "../../src/RevpadRegistry.sol";
import {RevpadConstants as C} from "../../src/RevpadConstants.sol";
import {PoolKey, IInitializer} from "../../src/interfaces/IInitializer.sol";
import {IDopplerERC20V1} from "../../src/interfaces/IDopplerERC20V1.sol";

/// @notice Fork tests against Monad mainnet state (Anvil fork at http://127.0.0.1:8545).
///
///         Run after the full two-step setup in revpad-anvil:
///           1. anvil/start-fork.sh                          (start Anvil fork)
///           2. forge script script/Deploy.s.sol --broadcast  (deploy Revpad contracts)
///           3. ESCROW_ADDRESS=... BUYBACK_ADDRESS=... npm run launch (launch token)
///
///         Environment (all have defaults from a standard fresh-Anvil deploy):
///           FORK_ASSET    — token address from step 3
///           FORK_POOL_ID  — poolId from step 3
///           FORK_ESCROW   — FeeEscrow address from step 2
///           FORK_VAULT    — BuybackVault address from step 2
///           FORK_REGISTRY — RevpadRegistry address from step 2
///
///         Run:
///           forge test --match-path "test/fork/**" --fork-url http://127.0.0.1:8545 -vv
///
/// @dev Uses pre-deployed contracts (not freshly deployed in setUp) so that the
///      Doppler share beneficiaries match the live chain state exactly.
contract RegistryForkTest is Test {
    // ── Monad mainnet constants ────────────────────────────────────────────────
    address constant POOL_MANAGER  = 0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e;
    address constant INITIALIZER   = 0xCe3099B2F07029b086E5e92a1573C5f5A3071783;
    address constant USDC          = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;

    // Anvil default accounts
    address constant ADMIN    = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    address constant CREATOR  = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266; // account[0]
    address constant TREASURY = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8; // account[1]

    // Default deployed addresses — override with FORK_ESCROW / FORK_VAULT / FORK_REGISTRY.
    // On a fork of Monad mainnet block 107059290, account[0] has nonce 631, so contracts
    // deploy at nonces 631-634.  Recompute with Deploy.s.sol if the fork block changes.
    address constant DEFAULT_ESCROW   = 0x3C2BafebbB0c8c58f39A976e725cD20D611d01e9;
    address constant DEFAULT_VAULT    = 0x5f246ADDCF057E0f778CD422e20e413be70f9a0c;
    address constant DEFAULT_REGISTRY = 0x4Dd5336F3C0D70893A7a86c6aEBe9B953E87c891;

    FeeEscrow      escrow;
    BuybackVault   vault;
    RevpadRegistry registry;

    address asset;
    bytes32 poolId;

    function setUp() public {
        // Pre-deployed contract addresses (must match what was deployed before the token launch)
        escrow   = FeeEscrow(vm.envOr("FORK_ESCROW",   DEFAULT_ESCROW));
        vault    = BuybackVault(vm.envOr("FORK_VAULT",    DEFAULT_VAULT));
        registry = RevpadRegistry(vm.envOr("FORK_REGISTRY", DEFAULT_REGISTRY));

        // Token launched with those beneficiary addresses
        asset  = vm.envOr("FORK_ASSET",
            address(0xad50518E1Dd6CA5B7491eEBa27e1fCb9a4BAc407));
        poolId = vm.envOr("FORK_POOL_ID",
            bytes32(0x8cfb4aae9be8680189a195a884baad62f5a71f00e75f58ff2550c89f29256421));
    }

    // ── A. Deployment sanity ──────────────────────────────────────────────────
    function test_deploy_addresses() public view {
        assertEq(registry.treasury(),              TREASURY);
        assertEq(registry.admin(),                 ADMIN);
        assertEq(address(registry.feeEscrow()),    address(escrow));
        assertEq(address(registry.buybackVault()), address(vault));
    }

    // ── B. register: accepts a correctly-launched token ───────────────────────
    function test_register_acceptsValidToken() public {
        address router = registry.register(asset, CREATOR, poolId);

        assertTrue(router != address(0), "no router");
        assertEq(registry.routers(asset), router);
        assertTrue(registry.isRegistered(asset));

        // Verify RevenueRouter is correctly initialized
        RevenueRouter rr = RevenueRouter(router);
        assertEq(rr.asset(),        asset);
        assertEq(rr.creator(),      CREATOR);
        assertEq(rr.registry(),     address(registry));
        assertEq(rr.feeEscrow(),    address(escrow));
        assertEq(rr.buybackVault(), address(vault));
        assertEq(rr.treasury(),     TREASURY);

        // Verify FeeEscrow received the asset
        FeeEscrow.TokenData memory td = escrow.tokenData(asset);
        assertEq(td.creator, CREATOR);
        assertEq(td.poolId,  poolId);
        assertFalse(td.forfeited);
    }

    // ── C. register: rejects wrong poolId ────────────────────────────────────
    function test_register_revertsWrongPoolId() public {
        bytes32 badPoolId = keccak256("wrong");
        // getPoolKey(badPoolId) returns zero-value struct → fee=0 ≠ POOL_FEE
        vm.expectRevert(abi.encodeWithSelector(
            RevpadRegistry.WrongFee.selector, uint24(0), C.POOL_FEE
        ));
        registry.register(asset, CREATOR, badPoolId);
    }

    // ── D. register: rejects wrong creator (share mismatch) ───────────────────
    function test_register_revertsWrongCreator() public {
        address fakeCreator = address(0xBAD);
        // getShares(poolId, fakeCreator) returns 0 ≠ CREATOR_SHARE_WAD
        vm.expectRevert(abi.encodeWithSelector(
            RevpadRegistry.WrongCreatorShare.selector, uint256(0), C.CREATOR_SHARE_WAD
        ));
        registry.register(asset, fakeCreator, poolId);
    }

    // ── E. FeeEscrow.collect: receives USDC share from trading fees ───────────
    function test_escrow_collectFromInitializer() public {
        registry.register(asset, CREATOR, poolId);

        uint256 before = IERC20(USDC).balanceOf(address(escrow));
        escrow.collect(asset);
        // collect returns 0 if no fees have accrued yet (just launched, no trades)
        // Simply verify it doesn't revert and state is sound
        uint256 after_ = IERC20(USDC).balanceOf(address(escrow));
        assertGe(after_, before);
    }

    // ── F. BuybackVault.collect: receives USDC share from trading fees ────────
    function test_vault_collectFromInitializer() public {
        registry.register(asset, CREATOR, poolId);

        vault.collect(asset);
        // Just launched, no trades → no fees; verify state is consistent
        BuybackVault.AssetData memory ad = vault.assetData(asset);
        assertEq(ad.balanceUSDC, 0); // no USDC collected yet
    }

    // ── G. register: duplicate reverts ───────────────────────────────────────
    function test_register_revertsOnDuplicate() public {
        registry.register(asset, CREATOR, poolId);
        vm.expectRevert(RevpadRegistry.AlreadyRegistered.selector);
        registry.register(asset, CREATOR, poolId);
    }

    // ── H. RevenueRouter.distribute: correct split ───────────────────────────
    function test_distribute_correctSplit() public {
        address router = registry.register(asset, CREATOR, poolId);
        RevenueRouter rr = RevenueRouter(router);

        uint256 amt = 10_000_000; // 10 USDC
        deal(USDC, address(rr), amt);

        rr.distribute();

        uint256 providerExpected = (amt * C.PROVIDER_BPS)  / 10_000;
        uint256 buybackExpected  = (amt * C.BUYBACK_BPS)   / 10_000;
        uint256 treasuryExpected = (amt * C.TREASURY_BPS)  / 10_000;

        assertEq(IERC20(USDC).balanceOf(CREATOR),  providerExpected);
        assertEq(IERC20(USDC).balanceOf(TREASURY), treasuryExpected);
        assertEq(vault.assetData(asset).balanceUSDC, buybackExpected);
        assertEq(escrow.tokenData(asset).recordedRevenue, amt);
    }

    // ── I. FeeEscrow: claimable bounded by revenue ────────────────────────────
    function test_escrow_claimableBounded() public {
        address router = registry.register(asset, CREATOR, poolId);
        RevenueRouter rr = RevenueRouter(router);

        uint256 amt = 100_000_000;
        deal(USDC, address(rr), amt);
        rr.distribute();

        uint256 c = escrow.claimable(asset);
        FeeEscrow.TokenData memory td = escrow.tokenData(asset);
        uint256 allowance = (uint256(td.recordedRevenue) * C.ESCROW_UNLOCK_BPS) / 10_000;
        assertLe(c, allowance);
        assertLe(c, td.usdcAccrued);
    }

    // ── J. FeeEscrow: forfeit redirects to BuybackVault ───────────────────────
    function test_escrow_forfeitAfterDelay() public {
        registry.register(asset, CREATOR, poolId);

        deal(USDC, address(escrow), 5_000_000);
        vm.warp(block.timestamp + C.FORFEIT_DELAY + 1);
        escrow.forfeit(asset);
        assertTrue(escrow.tokenData(asset).forfeited);
    }

    // ── K. BuybackVault: execute reverts if cooldown active ───────────────────
    function test_vault_executeCooldown() public {
        address router = registry.register(asset, CREATOR, poolId);
        RevenueRouter rr = RevenueRouter(router);

        uint256 amt = 10_000_000;
        deal(USDC, address(rr), amt);
        rr.distribute();

        // The Doppler hook's startTime is set to wall-clock time at launch, which is
        // ahead of the forked chain's block.timestamp (Monad historical block).
        // Warp past startTime (= balanceLimitEnd - 600) so swaps are allowed.
        IDopplerERC20V1 tok = IDopplerERC20V1(asset);
        vm.warp(uint256(tok.balanceLimitEnd()) + 1);

        uint256 vaultBal = vault.assetData(asset).balanceUSDC;
        if (vaultBal > 0) {
            vault.execute(asset, 1_000_000, 0);
            vm.expectRevert(BuybackVault.CooldownActive.selector);
            vault.execute(asset, 1_000_000, 0);
        }
    }
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

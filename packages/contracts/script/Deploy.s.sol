// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {FeeEscrow} from "../src/FeeEscrow.sol";
import {BuybackVault} from "../src/BuybackVault.sol";
import {RevenueRouter} from "../src/RevenueRouter.sol";
import {RevpadRegistry} from "../src/RevpadRegistry.sol";

/// @notice Deploy all Revpad contracts to a fork/testnet.
///
///   forge script script/Deploy.s.sol \
///     --rpc-url http://127.0.0.1:8545 \
///     --broadcast \
///     --private-key $PRIVATE_KEY
///
/// Env vars required:
///   ADMIN_ADDRESS    — admin of RevpadRegistry (defaults to msg.sender)
///   TREASURY_ADDRESS — treasury recipient (defaults to msg.sender)
///
/// After broadcast the script writes deployed addresses to
///   ../../revpad-anvil/.anvil-state/contracts.json
/// (fs_permissions in foundry.toml allow this path).
/// Fork tests read from CONTRACTS_JSON_PATH env var (default: same file).
/// The launch script (02-launch.ts) reads ESCROW_ADDRESS / BUYBACK_ADDRESS
/// from that JSON automatically when CONTRACTS_JSON_PATH is set.
///
/// Deployment order (nonce offsets from start nonce N):
///   N+0  FeeEscrow    — requires futureVault (N+1) and futureRegistry (N+3)
///   N+1  BuybackVault — requires futureRegistry (N+3)
///   N+2  RevenueRouter (implementation)
///   N+3  RevpadRegistry
///
/// The Monad mainnet pool manager address is hardcoded.
contract DeployRevpad is Script {
    // Monad mainnet V4 PoolManager (from Doppler SDK chain-143 MONAD_MAINNET addresses)
    address constant POOL_MANAGER = 0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e;
    address constant INITIALIZER  = 0xCe3099B2F07029b086E5e92a1573C5f5A3071783;

    // JSON output path (relative to Foundry project root = packages/contracts/)
    string constant CONTRACTS_JSON = "../../revpad-anvil/.anvil-state/contracts.json";

    function run() external {
        address admin    = vm.envOr("ADMIN_ADDRESS",    msg.sender);
        address treasury = vm.envOr("TREASURY_ADDRESS", msg.sender);

        vm.startBroadcast();

        // Pre-compute forward addresses so every constructor gets the correct immutables.
        // Nonce layout: escrow=N+0, vault=N+1, routerImpl=N+2, registry=N+3
        uint256 nonce          = vm.getNonce(msg.sender);
        address futureVault    = vm.computeCreateAddress(msg.sender, nonce + 1);
        address futureRegistry = vm.computeCreateAddress(msg.sender, nonce + 3);

        FeeEscrow     escrow     = new FeeEscrow(futureRegistry, futureVault, INITIALIZER); // N+0
        BuybackVault  vault      = new BuybackVault(futureRegistry, INITIALIZER, POOL_MANAGER); // N+1
        RevenueRouter routerImpl = new RevenueRouter();                                     // N+2
        RevpadRegistry registry  = new RevpadRegistry(
            treasury, address(escrow), address(vault), address(routerImpl), admin
        );                                                                                   // N+3

        require(address(registry) == futureRegistry, "nonce mismatch: registry");
        require(address(vault)    == futureVault,    "nonce mismatch: vault");

        vm.stopBroadcast();

        // ── Post-deploy wiring assertions ──────────────────────────────────────
        // These catch any future refactoring that breaks the immutable wiring.
        require(escrow.buybackVault()        == address(vault),     "escrow.buybackVault != vault");
        require(escrow.registry()            == address(registry),  "escrow.registry != registry");
        require(vault.registry()             == address(registry),  "vault.registry != registry");
        require(address(vault.poolManager()) != address(0),         "vault.poolManager is zero");
        require(address(vault.initializer()) != address(0),         "vault.initializer is zero");
        require(address(escrow.initializer())!= address(0),         "escrow.initializer is zero");

        // ── Console output ─────────────────────────────────────────────────────
        console.log("FeeEscrow    :", address(escrow));
        console.log("BuybackVault :", address(vault));
        console.log("RouterImpl   :", address(routerImpl));
        console.log("Registry     :", address(registry));
        console.log("Treasury     :", treasury);
        console.log("Admin        :", admin);
        console.log("Deployer     :", msg.sender);
        console.log("StartNonce   :", nonce);

        // ── Write contracts.json for fork tests and launch script ──────────────
        // IMPORTANT: vm.serializeXxx(objectKey, ...) uses the FIRST argument as a fixed
        // namespace/label, not the growing JSON string.  All calls must share the same
        // literal string so Foundry accumulates them into one object.  The LAST call's
        // return value is the complete JSON; that is what we write to disk.
        string memory obj = "contracts";
        vm.serializeAddress(obj, "deployer",          msg.sender);
        vm.serializeUint(obj,    "deployerStartNonce", nonce);
        vm.serializeAddress(obj, "escrow",            address(escrow));
        vm.serializeAddress(obj, "vault",             address(vault));
        vm.serializeAddress(obj, "routerImpl",        address(routerImpl));
        vm.serializeAddress(obj, "registry",          address(registry));
        vm.serializeAddress(obj, "treasury",          treasury);
        string memory finalJson = vm.serializeAddress(obj, "admin", admin); // last → full object
        vm.writeFile(CONTRACTS_JSON, finalJson);
        console.log("contracts.json:", finalJson);
    }
}

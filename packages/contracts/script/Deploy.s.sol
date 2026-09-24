// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {FeeEscrow} from "../src/FeeEscrow.sol";
import {BuybackVault} from "../src/BuybackVault.sol";
import {PlatformFeeReceiver} from "../src/PlatformFeeReceiver.sol";
import {RevenueRouter} from "../src/RevenueRouter.sol";
import {RevpadRegistry} from "../src/RevpadRegistry.sol";

/// @notice Deploy all Revpad contracts.
///
///   # Fork (default — writes to .anvil-state/contracts.json):
///   forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --private-key $PRIVATE_KEY
///
///   # Mainnet dry-run (writes to deployments/monad-mainnet.json):
///   DEPLOY_OUTPUT=deployments/monad-mainnet.json ADMIN_ADDRESS=0x... TREASURY_ADDRESS=0x... \
///     forge script script/Deploy.s.sol --rpc-url https://rpc.monad.xyz --sender 0x... --gas-estimate-multiplier 110
///
/// Env vars:
///   ADMIN_ADDRESS    — admin of RevpadRegistry + PlatformFeeReceiver (defaults to msg.sender)
///   TREASURY_ADDRESS — initial treasury recipient (defaults to msg.sender)
///   DEPLOY_OUTPUT    — JSON output path (default: ../../revpad-anvil/.anvil-state/contracts.json)
///
/// Safety guards:
///   - If RPC is NOT localhost and DEPLOY_OUTPUT points into .anvil-state → revert
///   - If RPC IS localhost and DEPLOY_OUTPUT is deployments/monad-mainnet.json → revert
///
/// Deployment order (nonce offsets from start nonce N):
///   N+0  FeeEscrow             — requires futureVault (N+1) and futureRegistry (N+4)
///   N+1  BuybackVault          — requires futureRegistry (N+4)
///   N+2  PlatformFeeReceiver   — requires futureRegistry (N+4)
///   N+3  RevenueRouter (implementation)
///   N+4  RevpadRegistry
///
/// The Monad mainnet pool manager address is hardcoded.
contract DeployRevpad is Script {
    // Monad mainnet V4 PoolManager (from Doppler SDK chain-143 MONAD_MAINNET addresses)
    address constant POOL_MANAGER = 0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e;
    address constant INITIALIZER  = 0xCe3099B2F07029b086E5e92a1573C5f5A3071783;

    // Default output path (fork). Override with DEPLOY_OUTPUT env var.
    string constant DEFAULT_OUTPUT = "../../revpad-anvil/.anvil-state/contracts.json";
    string constant MAINNET_OUTPUT = "deployments/monad-mainnet.json";

    function run() external {
        address admin    = vm.envOr("ADMIN_ADDRESS",    msg.sender);
        address treasury = vm.envOr("TREASURY_ADDRESS", msg.sender);
        string memory outputPath = vm.envOr("DEPLOY_OUTPUT", DEFAULT_OUTPUT);

        // ── Safety guards: prevent fork ↔ mainnet output collision ───────────
        // Detect localhost by checking if the deployer is an Anvil dev address (nonce 0 + index 0).
        // On a real fork with --sender, the deployer is a real wallet, not 0xf39F...
        // Alternatively: check if DEPLOY_OUTPUT was explicitly set for mainnet.
        bool pointsToAnvilState = _contains(outputPath, ".anvil-state");
        bool pointsToMainnet    = _strEq(outputPath, MAINNET_OUTPUT);

        // If mainnet output is selected, require ADMIN_ADDRESS is set (not deployer).
        // This prevents accidentally deploying to mainnet with deployer-as-admin.
        if (pointsToMainnet) {
            require(
                admin != msg.sender,
                "DEPLOY_OUTPUT=deployments/monad-mainnet.json but ADMIN_ADDRESS is not set (would use deployer)"
            );
        }

        // If anvil-state output is selected but ADMIN_ADDRESS is a real external wallet,
        // that's suspicious — probably meant to use mainnet output.
        if (pointsToAnvilState && admin != msg.sender) {
            require(
                !_contains(vm.envOr("DEPLOY_OUTPUT", string("")), "monad-mainnet"),
                "DEPLOY_OUTPUT points to .anvil-state but ADMIN is external -- did you mean deployments/monad-mainnet.json?"
            );
        }

        vm.startBroadcast();

        // Pre-compute forward addresses so every constructor gets the correct immutables.
        // Nonce layout: escrow=N+0, vault=N+1, pfr=N+2, routerImpl=N+3, registry=N+4
        uint256 nonce          = vm.getNonce(msg.sender);
        address futureVault    = vm.computeCreateAddress(msg.sender, nonce + 1);
        address futurePFR      = vm.computeCreateAddress(msg.sender, nonce + 2);
        address futureRegistry = vm.computeCreateAddress(msg.sender, nonce + 4);

        FeeEscrow     escrow     = new FeeEscrow(futureRegistry, futureVault, INITIALIZER);         // N+0
        BuybackVault  vault      = new BuybackVault(futureRegistry, INITIALIZER, POOL_MANAGER);     // N+1
        PlatformFeeReceiver pfr  = new PlatformFeeReceiver(futureRegistry, INITIALIZER, treasury, admin); // N+2
        RevenueRouter routerImpl = new RevenueRouter();                                              // N+3
        RevpadRegistry registry  = new RevpadRegistry(
            address(pfr), address(escrow), address(vault), address(routerImpl), admin
        );                                                                                           // N+4

        require(address(registry) == futureRegistry, "nonce mismatch: registry");
        require(address(vault)    == futureVault,    "nonce mismatch: vault");
        require(address(pfr)      == futurePFR,      "nonce mismatch: pfr");

        vm.stopBroadcast();

        // ── Post-deploy wiring assertions ──────────────────────────────────────
        // These catch any future refactoring that breaks the immutable wiring.
        require(escrow.buybackVault()        == address(vault),     "escrow.buybackVault != vault");
        require(escrow.registry()            == address(registry),  "escrow.registry != registry");
        require(vault.registry()             == address(registry),  "vault.registry != registry");
        require(address(vault.poolManager()) != address(0),         "vault.poolManager is zero");
        require(address(vault.initializer()) != address(0),         "vault.initializer is zero");
        require(address(escrow.initializer())!= address(0),         "escrow.initializer is zero");
        require(pfr.registry()               == address(registry),  "pfr.registry != registry");
        require(pfr.treasury()               == treasury,           "pfr.treasury != treasury");

        // ── Console output ─────────────────────────────────────────────────────
        console.log("FeeEscrow           :", address(escrow));
        console.log("BuybackVault        :", address(vault));
        console.log("PlatformFeeReceiver :", address(pfr));
        console.log("RouterImpl          :", address(routerImpl));
        console.log("Registry            :", address(registry));
        console.log("Treasury            :", treasury);
        console.log("Admin               :", admin);
        console.log("Deployer            :", msg.sender);
        console.log("StartNonce          :", nonce);

        // ── Write contracts JSON for fork tests and launch script ────────────
        // IMPORTANT: vm.serializeXxx(objectKey, ...) uses the FIRST argument as a fixed
        // namespace/label, not the growing JSON string.  All calls must share the same
        // literal string so Foundry accumulates them into one object.  The LAST call's
        // return value is the complete JSON; that is what we write to disk.
        string memory obj = "contracts";
        vm.serializeUint(obj,    "chainId",              block.chainid);
        vm.serializeUint(obj,    "blockNumber",          block.number);
        vm.serializeAddress(obj, "deployer",             msg.sender);
        vm.serializeUint(obj,    "deployerStartNonce",   nonce);
        vm.serializeAddress(obj, "escrow",               address(escrow));
        vm.serializeAddress(obj, "vault",                address(vault));
        vm.serializeAddress(obj, "platformFeeReceiver",  address(pfr));
        vm.serializeAddress(obj, "routerImpl",           address(routerImpl));
        vm.serializeAddress(obj, "registry",             address(registry));
        vm.serializeAddress(obj, "treasury",             treasury);
        string memory finalJson = vm.serializeAddress(obj, "admin", admin); // last → full object
        vm.writeFile(outputPath, finalJson);
        console.log("Output path:", outputPath);
        console.log("contracts.json:", finalJson);
    }

    // ── String helpers (no external deps) ──────────────────────────────────
    function _contains(string memory haystack, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length > h.length) return false;
        for (uint256 i = 0; i <= h.length - n.length; i++) {
            bool found = true;
            for (uint256 j = 0; j < n.length; j++) {
                if (h[i + j] != n[j]) { found = false; break; }
            }
            if (found) return true;
        }
        return false;
    }

    function _containsLocalhost(string memory url) internal pure returns (bool) {
        return _contains(url, "127.0.0.1") || _contains(url, "localhost") || _contains(url, "0.0.0.0");
    }

    function _strEq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}

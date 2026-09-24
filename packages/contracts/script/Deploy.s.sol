// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {FeeEscrow} from "../src/FeeEscrow.sol";
import {BuybackVault} from "../src/BuybackVault.sol";
import {PlatformFeeReceiver} from "../src/PlatformFeeReceiver.sol";
import {RevenueRouter} from "../src/RevenueRouter.sol";
import {AstralaunchRegistry} from "../src/AstralaunchRegistry.sol";

/// @notice Deploy all Astralaunch v2 contracts.
///
///   # Fork:
///   DEPLOY_OUTPUT=../../revpad-anvil/.anvil-state/contracts.json \
///     forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --private-key $PRIVATE_KEY
///
///   # Mainnet (dry-run):
///   DEPLOY_OUTPUT=deployments/monad-mainnet.json \
///   ADMIN_ADDRESS=0x... TREASURY_ADDRESS=0x... GUARDIAN_ADDRESS=0x... \
///     forge script script/Deploy.s.sol --rpc-url https://rpc.monad.xyz --sender 0x...
///
///   # Mainnet (broadcast):
///   DEPLOY_OUTPUT=deployments/monad-mainnet.json \
///   FOUNDRY_BROADCAST=broadcast-mainnet \
///   ADMIN_ADDRESS=0x... TREASURY_ADDRESS=0x... GUARDIAN_ADDRESS=0x... \
///     forge script script/Deploy.s.sol --rpc-url https://rpc.monad.xyz --broadcast \
///     --account astralaunch-deployer --gas-estimate-multiplier 110
///
/// Env vars (required):
///   DEPLOY_OUTPUT    — JSON output path. No default; reverts if unset.
///
/// Env vars (optional):
///   ADMIN_ADDRESS    — admin of AstralaunchRegistry + PlatformFeeReceiver (defaults to msg.sender)
///   TREASURY_ADDRESS — initial treasury recipient (defaults to msg.sender)
///   GUARDIAN_ADDRESS  — guardian (cancel-only role). Required for mainnet.
///
/// Deployment order (nonce offsets from start nonce N):
///   N+0  FeeEscrow             — requires futureRegistry (N+4)
///   N+1  BuybackVault          — requires futureRegistry (N+4)
///   N+2  PlatformFeeReceiver   — requires futureRegistry (N+4)
///   N+3  RevenueRouter (implementation)
///   N+4  AstralaunchRegistry   — seeds initial initializer + adapter
contract DeployAstralaunch is Script {
    // Monad mainnet V4 PoolManager
    address constant POOL_MANAGER = 0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e;
    // V4ScheduledMulticurveInitializer — the initial allowed initializer
    address constant INITIALIZER  = 0xCe3099B2F07029b086E5e92a1573C5f5A3071783;

    string constant FORK_OUTPUT    = "../../revpad-anvil/.anvil-state/contracts.json";
    string constant MAINNET_OUTPUT = "deployments/monad-mainnet.json";

    function run() external {
        address admin    = vm.envOr("ADMIN_ADDRESS",    msg.sender);
        address treasury = vm.envOr("TREASURY_ADDRESS", msg.sender);
        address guardian_ = vm.envOr("GUARDIAN_ADDRESS",  msg.sender);

        // ── DEPLOY_OUTPUT is mandatory ─────────────────────────────────────
        string memory outputPath = vm.envOr("DEPLOY_OUTPUT", string(""));
        require(
            bytes(outputPath).length > 0,
            "DEPLOY_OUTPUT env var is required. Valid values:\n"
            "  Fork:    DEPLOY_OUTPUT=../../revpad-anvil/.anvil-state/contracts.json\n"
            "  Mainnet: DEPLOY_OUTPUT=deployments/monad-mainnet.json"
        );

        // ── Safety guard: mainnet output requires explicit admin + guardian ─
        if (_strEq(outputPath, MAINNET_OUTPUT)) {
            require(
                admin != msg.sender,
                "DEPLOY_OUTPUT=deployments/monad-mainnet.json but ADMIN_ADDRESS is not set"
            );
            require(
                guardian_ != msg.sender,
                "DEPLOY_OUTPUT=deployments/monad-mainnet.json but GUARDIAN_ADDRESS is not set"
            );
        }

        bool isDryRun = !vm.isContext(VmSafe.ForgeContext.ScriptBroadcast);

        vm.startBroadcast();

        // Pre-compute forward addresses:
        // escrow=N+0, vault=N+1, pfr=N+2, routerImpl=N+3, registry=N+4
        uint256 nonce          = vm.getNonce(msg.sender);
        address futureVault    = vm.computeCreateAddress(msg.sender, nonce + 1);
        address futureRegistry = vm.computeCreateAddress(msg.sender, nonce + 4);

        FeeEscrow     escrow     = new FeeEscrow(futureRegistry, futureVault);                              // N+0
        BuybackVault  vault      = new BuybackVault(futureRegistry, address(POOL_MANAGER));                  // N+1
        PlatformFeeReceiver pfr  = new PlatformFeeReceiver(futureRegistry, treasury, admin, guardian_);      // N+2
        RevenueRouter routerImpl = new RevenueRouter();                                                       // N+3

        // The V4ScheduledMulticurveInitializer itself serves as the fee adapter
        // since it already implements collectFees, getShares, getState.
        AstralaunchRegistry registry = new AstralaunchRegistry(
            address(pfr),
            address(escrow),
            address(vault),
            address(routerImpl),
            admin,
            guardian_,
            INITIALIZER,  // initial allowed initializer
            INITIALIZER   // adapter = same contract (IFeeAdapter-compatible)
        );                                                                                                    // N+4

        require(address(registry) == futureRegistry, "nonce mismatch: registry");
        require(address(vault)    == futureVault,    "nonce mismatch: vault");

        vm.stopBroadcast();

        // ── Post-deploy wiring assertions ────────────────────────────────────
        require(escrow.buybackVault()        == address(vault),     "escrow.buybackVault != vault");
        require(escrow.registry()            == address(registry),  "escrow.registry != registry");
        require(vault.registry()             == address(registry),  "vault.registry != registry");
        require(address(vault.poolManager()) != address(0),         "vault.poolManager is zero");
        require(pfr.registry()               == address(registry),  "pfr.registry != registry");
        require(pfr.treasury()               == treasury,           "pfr.treasury != treasury");
        require(pfr.guardian()               == guardian_,           "pfr.guardian != guardian");
        require(registry.guardian()          == guardian_,           "registry.guardian != guardian");
        require(registry.allowedInitializers(INITIALIZER),          "initializer not seeded");

        // ── Console output ───────────────────────────────────────────────────
        console.log("FeeEscrow           :", address(escrow));
        console.log("BuybackVault        :", address(vault));
        console.log("PlatformFeeReceiver :", address(pfr));
        console.log("RouterImpl          :", address(routerImpl));
        console.log("Registry            :", address(registry));
        console.log("Treasury            :", treasury);
        console.log("Admin               :", admin);
        console.log("Guardian            :", guardian_);
        console.log("Deployer            :", msg.sender);
        console.log("StartNonce          :", nonce);

        // ── Write contracts JSON ─────────────────────────────────────────────
        string memory obj = "contracts";
        vm.serializeBool(obj,    "dryRun",               isDryRun);
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
        vm.serializeAddress(obj, "guardian",             guardian_);
        string memory finalJson = vm.serializeAddress(obj, "admin", admin);
        vm.writeFile(outputPath, finalJson);
        console.log("Output path:", outputPath);
        console.log("contracts.json:", finalJson);
    }

    function _strEq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}

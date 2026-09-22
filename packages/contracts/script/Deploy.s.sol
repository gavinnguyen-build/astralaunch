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
///   ADMIN_ADDRESS   — admin of RevpadRegistry
///   TREASURY_ADDRESS — treasury recipient
///
/// The Monad mainnet pool manager address is hardcoded.
contract DeployRevpad is Script {
    // Monad mainnet V4 PoolManager (from Doppler SDK chain-143 MONAD_MAINNET addresses)
    address constant POOL_MANAGER   = 0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e;
    address constant INITIALIZER    = 0xCe3099B2F07029b086E5e92a1573C5f5A3071783;

    function run() external {
        address admin    = vm.envOr("ADMIN_ADDRESS",    msg.sender);
        address treasury = vm.envOr("TREASURY_ADDRESS", msg.sender);

        vm.startBroadcast();

        // Deploy singletons — registry address pre-computed for constructor args
        // Nonce: escrow=+0, vault=+1, routerImpl=+2, registry=+3
        uint256 nonce = vm.getNonce(msg.sender);
        address futureRegistry = vm.computeCreateAddress(msg.sender, nonce + 3);

        FeeEscrow     escrow     = new FeeEscrow(futureRegistry, address(0), INITIALIZER);
        BuybackVault  vault      = new BuybackVault(futureRegistry, INITIALIZER, POOL_MANAGER);
        RevenueRouter routerImpl = new RevenueRouter();
        RevpadRegistry registry  = new RevpadRegistry(
            treasury, address(escrow), address(vault), address(routerImpl), admin
        );

        require(address(registry) == futureRegistry, "nonce mismatch");

        vm.stopBroadcast();

        console.log("FeeEscrow    :", address(escrow));
        console.log("BuybackVault :", address(vault));
        console.log("RouterImpl   :", address(routerImpl));
        console.log("Registry     :", address(registry));
        console.log("Treasury     :", treasury);
        console.log("Admin        :", admin);
    }
}

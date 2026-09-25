// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {LaunchHelper} from "../src/LaunchHelper.sol";

/// @notice Deploy LaunchHelper (periphery; the v2 core is unchanged). All parameters are fixed:
///         Doppler Airlock, the v2 registry from deployments/monad-mainnet.json, the launch-fee
///         treasury and 10 MON (LAUNCH_FEE_TREASURY / LAUNCH_FEE_WEI in packages/shared).
///
///   # Fork (Anvil dev key, local only):
///   DEPLOY_OUTPUT=../../astralaunch-anvil/.anvil-state/launch-helper.json \
///     forge script script/DeployLaunchHelper.s.sol --rpc-url http://127.0.0.1:8546 --broadcast --private-key $ANVIL_KEY
///
///   # Mainnet (dry-run first: same command without --broadcast):
///   DEPLOY_OUTPUT=deployments/monad-mainnet-launch-helper.json FOUNDRY_BROADCAST=broadcast-mainnet \
///     forge script script/DeployLaunchHelper.s.sol --rpc-url https://rpc.monad.xyz --broadcast \
///     --account astralaunch-deployer --sender 0x11e2dD9a4B9062675fD89178a2C9778182Dfcbc6 --gas-estimate-multiplier 110
contract DeployLaunchHelper is Script {
    // Sources: SPEC §23 / packages/shared/src/addresses.ts (AIRLOCK, LAUNCH_FEE_TREASURY),
    // packages/shared/src/constants.ts (LAUNCH_FEE_WEI = 10 MON).
    address constant AIRLOCK = 0x660eAaEdEBc968f8f3694354FA8EC0b4c5Ba8D12;
    address constant TREASURY = 0x888F0BDd45e460B4Af4A4a58D183Ea86CE9A351C;
    uint256 constant FEE = 10 ether;
    string constant DEPLOYMENT = "deployments/monad-mainnet.json";

    function run() external returns (LaunchHelper helper) {
        string memory out = vm.envString("DEPLOY_OUTPUT"); // required: no default output path
        require(block.chainid == 143, "Monad (chain 143) or a fork of it only");
        address registry = vm.parseJsonAddress(vm.readFile(DEPLOYMENT), ".registry");
        require(AIRLOCK.code.length > 0, "Airlock has no code");
        require(registry.code.length > 0, "registry has no code");

        vm.startBroadcast();
        helper = new LaunchHelper(AIRLOCK, registry, TREASURY, FEE);
        vm.stopBroadcast();

        require(address(helper.airlock()) == AIRLOCK && address(helper.registry()) == registry, "wiring");
        require(helper.treasury() == TREASURY && helper.launchFee() == FEE, "fee config");

        string memory o = "launchHelper";
        vm.serializeAddress(o, "launchHelper", address(helper));
        vm.serializeAddress(o, "airlock", AIRLOCK);
        vm.serializeAddress(o, "registry", registry);
        vm.serializeAddress(o, "treasury", TREASURY);
        vm.serializeUint(o, "launchFee", FEE);
        // Without --broadcast the address is only a simulation: flag it so nobody configures it.
        vm.serializeBool(o, "dryRun", !vm.isContext(VmSafe.ForgeContext.ScriptBroadcast));
        vm.serializeUint(o, "chainId", block.chainid);
        string memory json = vm.serializeUint(o, "blockNumber", block.number);
        vm.writeJson(json, out);
        console.log("LaunchHelper", address(helper));
        console.log("written to", out);
    }
}

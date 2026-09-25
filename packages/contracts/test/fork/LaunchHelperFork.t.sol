// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {LaunchHelper, CreateParams} from "../../src/LaunchHelper.sol";
import {AstralaunchRegistry} from "../../src/AstralaunchRegistry.sol";
import {AstralaunchConstants as C} from "../../src/AstralaunchConstants.sol";
import {IAirlock} from "../../src/interfaces/IAirlock.sol";
import {IDopplerERC20V1} from "../../src/interfaces/IDopplerERC20V1.sol";

/// @notice LaunchHelper against the REAL Doppler Airlock and the deployed v2 AstralaunchRegistry on an
///         Anvil fork of Monad mainnet. CreateParams come from the Doppler SDK via the browser code path
///         (apps/web/scripts/launch-helper-fixture.ts); this test never encodes the multicurve itself.
///
///   anvil --fork-url $MONAD_RPC_URL --chain-id 143 --port 8546 --network monad ...
///   (cd apps/web && ANVIL_RPC=http://127.0.0.1:8546 pnpm exec tsx scripts/launch-helper-fixture.ts)
///   forge test --fork-url http://127.0.0.1:8546 --match-path test/fork/LaunchHelperFork.t.sol -vv
contract LaunchHelperForkTest is Test {
    string constant FIXTURE = "../../astralaunch-anvil/.anvil-state/launch-helper-fixture.json";
    string constant DEPLOYMENT = "deployments/monad-mainnet.json";

    address constant AIRLOCK = 0x660eAaEdEBc968f8f3694354FA8EC0b4c5Ba8D12;
    address constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address constant WMON = 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A;
    address constant TREASURY = 0x888F0BDd45e460B4Af4A4a58D183Ea86CE9A351C;
    uint256 constant FEE = 10 ether;

    bytes32 constant FEE_TOPIC = keccak256("LaunchFeePaid(address,address,uint256)");
    bytes32 constant REGISTERED_TOPIC =
        keccak256("Registered(address,address,address,bytes32,address,address,uint256)");

    AstralaunchRegistry registry;
    address pfr;
    LaunchHelper helper;
    string fixture;

    function setUp() public {
        require(block.chainid == 143, "run with --fork-url <Anvil fork of Monad mainnet>");
        require(AIRLOCK.code.length > 0, "Doppler Airlock not found: not a Monad fork");
        fixture = vm.readFile(FIXTURE);
        string memory d = vm.readFile(DEPLOYMENT);
        registry = AstralaunchRegistry(vm.parseJsonAddress(d, ".registry"));
        pfr = vm.parseJsonAddress(d, ".platformFeeReceiver");
        helper = new LaunchHelper(AIRLOCK, address(registry), TREASURY, FEE);
    }

    function _load(string memory pairing) internal view returns (CreateParams memory p, address creator) {
        p = abi.decode(vm.parseJsonBytes(fixture, string.concat(".", pairing, ".createParams")), (CreateParams));
        creator = vm.parseJsonAddress(fixture, string.concat(".", pairing, ".creator"));
    }

    function _launchAndCheck(string memory pairing, address numeraire, uint256 value) internal {
        (CreateParams memory p, address creator) = _load(pairing);
        vm.deal(creator, 100 ether);
        uint256 treasuryBefore = TREASURY.balance;
        uint256 creatorBefore = creator.balance;

        vm.recordLogs();
        vm.prank(creator, creator);
        uint256 g = gasleft();
        (address asset, address router) = helper.launch{value: value}(p, creator);
        uint256 gasUsed = g - gasleft();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        console.log(string.concat(pairing, " launch via helper, gas:"), gasUsed);
        console.log("  asset", asset);
        console.log("  router", router);

        // Registered in the v2 registry, with the right numeraire and router.
        assertEq(registry.routers(asset), router, "router registered");
        assertEq(registry.assetNumeraires(asset), numeraire, "numeraire");
        assertTrue(registry.isRegistered(asset));

        // Doppler state matches the Astralaunch config (the registry verified it; spot-check here).
        (address num,,,,,,, uint256 toSell, uint256 supply, address integrator) = IAirlock(AIRLOCK).getAssetData(asset);
        assertEq(num, numeraire);
        assertEq(supply, C.TOTAL_SUPPLY);
        assertEq(toSell, C.POOL_TOKENS_NUM);
        assertEq(integrator, pfr, "integrator = PlatformFeeReceiver");
        assertEq(IDopplerERC20V1(asset).totalAllocatedOf(creator), C.VESTED_TOKENS_NUM, "creator vesting");

        // Fee: exactly `value` to the treasury, nothing kept by the helper.
        assertEq(TREASURY.balance - treasuryBefore, value, "treasury received the fee");
        assertEq(creatorBefore - creator.balance, value, "launcher paid exactly the fee (no gas on a prank)");
        assertEq(address(helper).balance, 0, "helper holds nothing");

        // Events: Registered(creator) from the registry; LaunchFeePaid only when a fee was paid.
        bool sawRegistered;
        bool sawFee;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(registry) && logs[i].topics[0] == REGISTERED_TOPIC) {
                assertEq(address(uint160(uint256(logs[i].topics[1]))), asset);
                assertEq(address(uint160(uint256(logs[i].topics[2]))), creator);
                sawRegistered = true;
            }
            if (logs[i].topics[0] == FEE_TOPIC) {
                assertEq(logs[i].emitter, address(helper));
                assertEq(address(uint160(uint256(logs[i].topics[1]))), creator, "launcher");
                assertEq(address(uint160(uint256(logs[i].topics[2]))), asset);
                assertEq(abi.decode(logs[i].data, (uint256)), FEE);
                sawFee = true;
            }
        }
        assertTrue(sawRegistered, "Registered emitted in the same tx");
        assertEq(sawFee, value != 0, "LaunchFeePaid iff a fee was paid");
    }

    function test_fork_usdcPair_oneTransaction() public {
        _launchAndCheck("usdc", USDC, FEE);
    }

    function test_fork_monPair_oneTransaction() public {
        _launchAndCheck("mon", WMON, FEE);
    }

    function test_fork_zeroFee_existingReceipt() public {
        _launchAndCheck("usdc", USDC, 0);
    }

    function test_fork_wrongCreator_revertsAtomically_noFee() public {
        (CreateParams memory p, address creator) = _load("usdc");
        address notCreator = address(0xBEEF);
        vm.deal(creator, 100 ether);
        uint256 treasuryBefore = TREASURY.balance;
        vm.prank(creator, creator);
        // The creator's 35% share / vesting belongs to `creator`, not `notCreator`: register reverts.
        vm.expectRevert(abi.encodeWithSelector(AstralaunchRegistry.WrongCreatorShare.selector, 0, C.CREATOR_SHARE_WAD));
        helper.launch{value: FEE}(p, notCreator);
        assertEq(TREASURY.balance, treasuryBefore, "no fee taken");
        assertEq(creator.balance, 100 ether, "launcher refunded by the revert");
    }

    function test_fork_wrongFee_reverts() public {
        (CreateParams memory p, address creator) = _load("mon");
        vm.deal(creator, 100 ether);
        vm.prank(creator, creator);
        vm.expectRevert(abi.encodeWithSelector(LaunchHelper.WrongFee.selector, FEE - 1, FEE));
        helper.launch{value: FEE - 1}(p, creator);
    }

    /// The same SDK params also work through a direct Airlock.create (the helper is not a special path):
    /// the helper as msg.sender of create produces a token the registry accepts, like an EOA does.
    function test_fork_directAirlockCreate_stillRegisters() public {
        (CreateParams memory p, address creator) = _load("usdc");
        vm.prank(creator, creator);
        (bool ok, bytes memory ret) = AIRLOCK.call(
            abi.encodeWithSignature(
                "create((uint256,uint256,address,address,bytes,address,bytes,address,bytes,address,bytes,address,bytes32))",
                p
            )
        );
        assertTrue(ok, "direct create");
        address asset = abi.decode(ret, (address));
        vm.prank(creator, creator);
        registry.register(asset, creator);
        assertTrue(registry.isRegistered(asset));
    }
}

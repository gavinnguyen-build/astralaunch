// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";

/// @notice Probes every on-chain field that AstralaunchRegistry must read.
///         Run against the Anvil fork AFTER launching a token with 02-launch:
///
///   ASSET=<addr> POOL_ID=<bytes32> \
///   CREATOR=<addr> ESCROW_STUB=<addr> BUYBACK_STUB=<addr> TREASURY_STUB=<addr> \
///   forge script src/spike/FieldSpike.s.sol --rpc-url http://127.0.0.1:8545 -vv
///
///         Results are recorded in docs/decisions.md.
///         Any FAIL line means: stop and ask before implementing AstralaunchRegistry.
contract FieldSpike is Script {
    // ── Known addresses (SPEC §23) ────────────────────────────────────────────
    address constant AIRLOCK     = 0x660eAaEdEBc968f8f3694354FA8EC0b4c5Ba8D12;
    address constant INITIALIZER = 0xCe3099B2F07029b086E5e92a1573C5f5A3071783;
    address constant USDC        = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address constant AIRLOCK_OWNER = 0x21E2ce70511e4FE542a97708e89520471DAa7A66;
    address constant NOMIG       = 0x5F3bA43D44375286296Cb85F1EA2EBfa25dde731;
    // NOGOV = dead address (actual noOp governance instance; 0xb4deE32... is the factory)
    address constant NOGOV       = 0x000000000000000000000000000000000000dEaD;

    // Expected values
    uint256 constant TOTAL_SUPPLY       = 1_000_000_000 * 1e18;
    uint256 constant POOL_TOKENS        = 850_000_000  * 1e18;
    uint256 constant BALANCE_CAP        = 10_000_000   * 1e18;
    uint256 constant ESCROW_SHARE_WAD   = 0.20e18;
    uint256 constant BUYBACK_SHARE_WAD  = 0.10e18;
    uint256 constant TREASURY_SHARE_WAD = 0.30e18;
    uint256 constant CREATOR_SHARE_WAD  = 0.35e18;
    uint256 constant DOPPLER_SHARE_WAD  = 0.05e18;
    uint24  constant POOL_FEE           = 20_000;
    int24   constant TICK_SPACING       = 200;
    uint64  constant VESTING_CLIFF      = uint64(30  days);
    uint64  constant VESTING_DURATION   = uint64(365 days);

    struct PoolKey {
        address currency0;
        address currency1;
        uint24  fee;
        int24   tickSpacing;
        address hooks;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────
    function _call(address target, bytes memory data)
        internal returns (bytes memory ret, bool ok)
    {
        (ok, ret) = target.call(data);
    }

    function _u256(bytes memory ret) internal pure returns (uint256) {
        if (ret.length < 32) return 0;
        return abi.decode(ret, (uint256));
    }

    function _pass(string memory label, bool ok) internal pure {
        console.log(ok
            ? string.concat("  PASS  ", label)
            : string.concat("  FAIL  ", label));
    }

    // ── run ───────────────────────────────────────────────────────────────────
    function run() external {
        address asset    = vm.envAddress("ASSET");
        bytes32 poolId   = vm.envBytes32("POOL_ID");
        address creator  = vm.envOr("CREATOR",      address(0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266));
        address escrow   = vm.envOr("ESCROW_STUB",  address(0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC));
        address buyback  = vm.envOr("BUYBACK_STUB", address(0x90F79bf6EB2c4f870365E785982E1f101E93b906));
        address treasury = vm.envOr("TREASURY_STUB",address(0x70997970C51812dc3A010C7d01b50e0d17dc79C8));

        console.log("=== FieldSpike: registry on-chain readability ===");
        console.log("asset   :", asset);
        console.log("poolId  :", vm.toString(poolId));
        console.log("");

        // ── A. Airlock.getAssetData ───────────────────────────────────────────
        console.log("-- A. Airlock.getAssetData(asset) --");
        (bytes memory retA, bool okA) = _call(
            AIRLOCK, abi.encodeWithSignature("getAssetData(address)", asset)
        );
        _pass("getAssetData exists", okA);
        if (okA) {
            (
                address numeraire,, address governance, address migrator,
                address init_,,,
                uint256 numTokensToSell, uint256 totalSupply_,
            ) = abi.decode(retA,
                (address,address,address,address,address,address,address,uint256,uint256,address));
            _pass("numeraire == USDC",        numeraire    == USDC);
            _pass("migrator == NoOpMigrator", migrator     == NOMIG);
            _pass("governance == 0xdEaD (noOp)", governance == NOGOV);
            _pass("initializer correct",      init_        == INITIALIZER);
            _pass("totalSupply == 1e9",       totalSupply_ == TOTAL_SUPPLY);
            _pass("numTokensToSell == 85%",   numTokensToSell == POOL_TOKENS);
        }
        console.log("");

        // ── B. PoolKey by poolId ─────────────────────────────────────────────
        // Spike-confirmed: getPoolKey(bytes32 poolId), NOT getPoolKey(address asset).
        // See docs/decisions.md Decision D2.
        console.log("-- B. IInitializer.getPoolKey(bytes32 poolId) --");
        (bytes memory retPK, bool okPK) = _call(
            INITIALIZER, abi.encodeWithSignature("getPoolKey(bytes32)", poolId)
        );
        _pass("getPoolKey(bytes32) exists", okPK && retPK.length >= 160);
        if (okPK && retPK.length >= 160) {
            PoolKey memory pk = abi.decode(retPK, (PoolKey));
            _pass("fee == 20000",       pk.fee == POOL_FEE);
            _pass("tickSpacing == 200", pk.tickSpacing == TICK_SPACING);
            console.log("  currency0:", pk.currency0);
            console.log("  currency1:", pk.currency1);
            console.log("  hooks    :", pk.hooks);

            // Verify poolId derivation matches what was passed in
            bytes32 derivedId = keccak256(abi.encode(pk));
            _pass("keccak256(abi.encode(poolKey)) matches env POOL_ID", derivedId == poolId);
            if (derivedId != poolId) {
                console.log("  derived  :", vm.toString(derivedId));
                console.log("  env      :", vm.toString(poolId));
            }

            // Anti-spoofing: verify asset is one of the currencies
            bool assetInPool = (pk.currency0 == asset || pk.currency1 == asset);
            _pass("asset is a pool currency", assetInPool);
        }
        console.log("");

        // ── C. Beneficiary shares ─────────────────────────────────────────────
        console.log("-- C. IInitializer.getShares(poolId, beneficiary) --");
        _checkShare("doppler  (0.05)",  AIRLOCK_OWNER, DOPPLER_SHARE_WAD,  poolId);
        _checkShare("creator  (0.35)",  creator,       CREATOR_SHARE_WAD,  poolId);
        _checkShare("escrow   (0.20)",  escrow,        ESCROW_SHARE_WAD,   poolId);
        _checkShare("buyback  (0.10)",  buyback,       BUYBACK_SHARE_WAD,  poolId);
        _checkShare("treasury (0.30)",  treasury,      TREASURY_SHARE_WAD, poolId);
        console.log("");

        // ── D. DopplerERC20V1 fields ──────────────────────────────────────────
        console.log("-- D. DopplerERC20V1 fields --");

        (bytes memory retTS, bool okTS) = _call(asset, abi.encodeWithSignature("totalSupply()"));
        _pass("totalSupply() exists", okTS);
        if (okTS) _pass("totalSupply == 1e9", _u256(retTS) == TOTAL_SUPPLY);

        (bytes memory retMBL, bool okMBL) = _call(asset, abi.encodeWithSignature("maxBalanceLimit()"));
        _pass("maxBalanceLimit() exists", okMBL);
        if (okMBL) _pass("maxBalanceLimit == 1%", _u256(retMBL) == BALANCE_CAP);

        (bytes memory retBLE, bool okBLE) = _call(asset, abi.encodeWithSignature("balanceLimitEnd()"));
        _pass("balanceLimitEnd() exists", okBLE);
        if (okBLE) console.log("  balanceLimitEnd:", _u256(retBLE));

        (bytes memory retVS, bool okVS) = _call(asset, abi.encodeWithSignature("vestingStart()"));
        _pass("vestingStart() exists", okVS);
        if (okVS) console.log("  vestingStart   :", _u256(retVS));

        (bytes memory retSched, bool okSched) = _call(
            asset, abi.encodeWithSignature("vestingSchedules(uint256)", uint256(0))
        );
        _pass("vestingSchedules(0) exists", okSched && retSched.length >= 64);
        if (okSched && retSched.length >= 64) {
            (uint64 cliff, uint64 duration) = abi.decode(retSched, (uint64, uint64));
            _pass("cliff == 30 days",     cliff    == VESTING_CLIFF);
            _pass("duration == 365 days", duration == VESTING_DURATION);
        }
        console.log("");

        // ── E. burn selector ─────────────────────────────────────────────────
        console.log("-- E. burn(uint256) selector on asset token --");
        (bytes memory retBurn, bool okBurn) = _call(
            asset, abi.encodeWithSignature("burn(uint256)", uint256(0))
        );
        // Any non-selector-not-found response means the function exists.
        // A revert with data (e.g. ERC20InsufficientBalance) still proves the selector exists.
        bool burnExists = okBurn || retBurn.length > 0;
        _pass("burn(uint256) selector exists", burnExists);
        if (!burnExists) {
            console.log("  NOTE: if burn reverts on amount=0, try a non-zero staticcall manually");
        }
        console.log("");

        console.log("=== Spike done. Check for FAIL lines above. ===");
    }

    function _checkShare(
        string memory label,
        address beneficiary,
        uint256 expected,
        bytes32 poolId
    ) internal {
        (bytes memory ret, bool ok) = _call(
            INITIALIZER,
            abi.encodeWithSignature("getShares(bytes32,address)", poolId, beneficiary)
        );
        if (!ok || ret.length < 32) {
            console.log(string.concat("  FAIL  getShares reverted for ", label));
            return;
        }
        uint256 got = abi.decode(ret, (uint256));
        if (got == expected) {
            console.log(string.concat("  PASS  share ", label));
        } else {
            console.log(
                string.concat(
                    "  FAIL  share ", label,
                    " got=", vm.toString(got),
                    " expected=", vm.toString(expected)
                )
            );
        }
    }
}

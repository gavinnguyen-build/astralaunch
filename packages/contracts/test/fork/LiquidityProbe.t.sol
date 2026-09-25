// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";

/// @notice Probes on-chain state for USDC/MON and USDC/WMON liquidity pools on Monad.
///
///         Checks:
///           1. Uniswap v4 (PoolManager): native MON (address(0)) / USDC — all fee/tickSpacing combos
///           2. Uniswap v4 (PoolManager): WMON / USDC (ERC-20 pair) — all fee/tickSpacing combos
///           3. Chainlink MON/USD oracle verification
///
///         Run:
///           forge test --match-path "test/fork/LiquidityProbe*" --fork-url http://127.0.0.1:8545 -vv
///
///         Or on mainnet:
///           forge test --match-path "test/fork/LiquidityProbe*" --fork-url $MONAD_RPC_URL -vv
contract LiquidityProbeTest is Test {
    address constant POOL_MANAGER = 0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e;
    address constant USDC         = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address constant WMON         = 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A;
    address constant MON_USD_ORACLE = 0xBcD78f76005B7515837af6b50c7C52BCf73822fb;

    struct PoolKey {
        address currency0;
        address currency1;
        uint24  fee;
        int24   tickSpacing;
        address hooks;
    }

    uint24[] fees = [uint24(100), 500, 3000, 10000, 20000];
    int24[]  tickSpacings = [int24(1), 10, 60, 200];

    /// @notice Probe Uniswap v4 PoolManager for native MON/USDC pools (currency0=address(0)).
    ///         This is the primary liquidity source for two-hop buyback.
    function test_probeV4NativeMonPools() public view {
        // Native MON = address(0), which sorts before USDC
        address c0 = address(0);
        address c1 = USDC;

        console.log("=== Uniswap v4 Native MON/USDC Pool Probe ===");
        console.log("currency0: address(0) (native MON)");
        console.log("currency1:", c1, "(USDC)");
        console.log("");

        uint256 found = 0;

        for (uint256 i = 0; i < fees.length; i++) {
            for (uint256 j = 0; j < tickSpacings.length; j++) {
                PoolKey memory key = PoolKey({
                    currency0:   c0,
                    currency1:   c1,
                    fee:         fees[i],
                    tickSpacing: tickSpacings[j],
                    hooks:       address(0)
                });

                bytes32 poolId = keccak256(abi.encode(key));
                bytes32 stateSlot = keccak256(abi.encode(poolId, uint256(6)));
                bytes32 slot0 = vm.load(POOL_MANAGER, stateSlot);
                uint160 sqrtPrice = uint160(uint256(slot0));

                if (sqrtPrice != 0) {
                    found++;
                    bytes32 liqSlot = bytes32(uint256(stateSlot) + 3);
                    uint128 liquidity = uint128(uint256(vm.load(POOL_MANAGER, liqSlot)));

                    console.log("FOUND native MON/USDC pool:");
                    console.log("  fee:         ", fees[i]);
                    console.log("  tickSpacing: ", uint256(uint24(tickSpacings[j])));
                    console.log("  sqrtPriceX96:", sqrtPrice);
                    console.log("  liquidity:   ", liquidity);
                    console.log("");
                }
            }
        }

        console.log("Native MON/USDC pools found:", found);
        if (found == 0) {
            console.log("NO native MON/USDC v4 pools found.");
        }
    }

    /// @notice Probe Uniswap v4 PoolManager for all WMON/USDC (ERC-20) pool variants.
    function test_probeV4WmonPools() public view {
        // currency0 < currency1 by Uniswap convention
        (address c0, address c1) = USDC < WMON
            ? (USDC, WMON)
            : (WMON, USDC);

        console.log("=== Uniswap v4 WMON/USDC Pool Probe ===");
        console.log("currency0:", c0);
        console.log("currency1:", c1);
        console.log("");

        uint256 found = 0;

        for (uint256 i = 0; i < fees.length; i++) {
            for (uint256 j = 0; j < tickSpacings.length; j++) {
                PoolKey memory key = PoolKey({
                    currency0:   c0,
                    currency1:   c1,
                    fee:         fees[i],
                    tickSpacing: tickSpacings[j],
                    hooks:       address(0)
                });

                bytes32 poolId = keccak256(abi.encode(key));
                bytes32 stateSlot = keccak256(abi.encode(poolId, uint256(6)));
                bytes32 slot0 = vm.load(POOL_MANAGER, stateSlot);
                uint160 sqrtPrice = uint160(uint256(slot0));

                if (sqrtPrice != 0) {
                    found++;
                    bytes32 liqSlot = bytes32(uint256(stateSlot) + 3);
                    uint128 liquidity = uint128(uint256(vm.load(POOL_MANAGER, liqSlot)));

                    console.log("FOUND WMON/USDC pool:");
                    console.log("  fee:         ", fees[i]);
                    console.log("  tickSpacing: ", uint256(uint24(tickSpacings[j])));
                    console.log("  sqrtPriceX96:", sqrtPrice);
                    console.log("  liquidity:   ", liquidity);
                    console.log("");
                }
            }
        }

        // Also probe with Doppler hook address
        address DOPPLER_HOOK = 0x580ca49389d83b019d07E17e99454f2F218e2dc0;
        for (uint256 i = 0; i < fees.length; i++) {
            for (uint256 j = 0; j < tickSpacings.length; j++) {
                PoolKey memory key = PoolKey({
                    currency0:   c0,
                    currency1:   c1,
                    fee:         fees[i],
                    tickSpacing: tickSpacings[j],
                    hooks:       DOPPLER_HOOK
                });

                bytes32 poolId = keccak256(abi.encode(key));
                bytes32 stateSlot = keccak256(abi.encode(poolId, uint256(6)));
                bytes32 slot0 = vm.load(POOL_MANAGER, stateSlot);
                uint160 sqrtPrice = uint160(uint256(slot0));

                if (sqrtPrice != 0) {
                    found++;
                    bytes32 liqSlot = bytes32(uint256(stateSlot) + 3);
                    uint128 liquidity = uint128(uint256(vm.load(POOL_MANAGER, liqSlot)));

                    console.log("FOUND WMON/USDC pool (Doppler hook):");
                    console.log("  fee:         ", fees[i]);
                    console.log("  tickSpacing: ", uint256(uint24(tickSpacings[j])));
                    console.log("  sqrtPriceX96:", sqrtPrice);
                    console.log("  liquidity:   ", liquidity);
                    console.log("");
                }
            }
        }

        console.log("WMON/USDC pools found:", found);
        if (found == 0) {
            console.log("NO WMON/USDC v4 pools found.");
        }
    }

    /// @notice Verify Chainlink MON/USD oracle on Monad.
    function test_probeChainlinkOracle() public view {
        console.log("=== Chainlink MON/USD Oracle Probe ===");
        console.log("Oracle address:", MON_USD_ORACLE);

        uint256 codeSize;
        assembly { codeSize := extcodesize(MON_USD_ORACLE) }
        if (codeSize == 0) {
            console.log("  NO CONTRACT at oracle address");
            return;
        }

        // latestRoundData()
        (bool ok, bytes memory ret) = MON_USD_ORACLE.staticcall(
            abi.encodeWithSignature("latestRoundData()")
        );
        if (ok && ret.length >= 160) {
            (uint80 roundId, int256 answer, , uint256 updatedAt, ) =
                abi.decode(ret, (uint80, int256, uint256, uint256, uint80));
            console.log("  roundId:   ", roundId);
            console.log("  answer:    ", uint256(answer));
            console.log("  updatedAt: ", updatedAt);

            uint256 staleness = block.timestamp > updatedAt ? block.timestamp - updatedAt : 0;
            console.log("  staleness: ", staleness, "seconds");
        } else {
            console.log("  latestRoundData() call failed");
        }

        // decimals()
        (bool ok2, bytes memory ret2) = MON_USD_ORACLE.staticcall(
            abi.encodeWithSignature("decimals()")
        );
        if (ok2 && ret2.length >= 32) {
            uint8 dec = abi.decode(ret2, (uint8));
            console.log("  decimals:  ", uint256(dec));
        }

        // description()
        (bool ok3, bytes memory ret3) = MON_USD_ORACLE.staticcall(
            abi.encodeWithSignature("description()")
        );
        if (ok3 && ret3.length > 64) {
            string memory desc = abi.decode(ret3, (string));
            console.log("  description:", desc);
        }
    }
}

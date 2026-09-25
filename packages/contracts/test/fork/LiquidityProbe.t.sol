// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";

/// @notice Probes on-chain state for USDC/WMON liquidity pools on Monad.
///
///         Checks:
///           1. Uniswap v4 (PoolManager): all fee/tickSpacing combos, hooks=0
///           2. Informational: logs pool state for any initialized pools
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

    struct PoolKey {
        address currency0;
        address currency1;
        uint24  fee;
        int24   tickSpacing;
        address hooks;
    }

    uint24[] fees = [uint24(100), 500, 3000, 10000, 20000];
    int24[]  tickSpacings = [int24(1), 10, 60, 200];

    /// @notice Probe Uniswap v4 PoolManager for all USDC/WMON pool variants.
    function test_probeV4Pools() public view {
        // currency0 < currency1 by Uniswap convention
        (address c0, address c1) = USDC < WMON
            ? (USDC, WMON)
            : (WMON, USDC);

        console.log("=== Uniswap v4 USDC/WMON Pool Probe ===");
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

                // Read sqrtPriceX96 via extsload.
                // Uniswap v4 stores Pool.State at: keccak256(abi.encode(poolId, POOLS_SLOT))
                // Pool.State layout: slot+0 = sqrtPriceX96 (uint160) | tick (int24) | ...
                // POOLS_SLOT for PoolManager = 6 (v4-core storage)
                bytes32 stateSlot = keccak256(abi.encode(poolId, uint256(6)));
                bytes32 slot0 = vm.load(POOL_MANAGER, stateSlot);

                // sqrtPriceX96 is in the lower 160 bits of slot0
                uint160 sqrtPrice = uint160(uint256(slot0));

                if (sqrtPrice != 0) {
                    found++;
                    // Read liquidity from slot+3
                    bytes32 liqSlot = bytes32(uint256(stateSlot) + 3);
                    uint128 liquidity = uint128(uint256(vm.load(POOL_MANAGER, liqSlot)));

                    console.log("FOUND pool:");
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

                    console.log("FOUND pool (Doppler hook):");
                    console.log("  fee:         ", fees[i]);
                    console.log("  tickSpacing: ", uint256(uint24(tickSpacings[j])));
                    console.log("  sqrtPriceX96:", sqrtPrice);
                    console.log("  liquidity:   ", liquidity);
                    console.log("");
                }
            }
        }

        console.log("Total pools found:", found);
        if (found == 0) {
            console.log("NO USDC/WMON v4 pools found on this chain state.");
            console.log("Buyback for WMON-paired tokens requires external DEX liquidity.");
        }
    }

    /// @notice Check if common DEX router/factory contracts exist at known addresses.
    function test_probeKnownDEXes() public view {
        console.log("=== DEX Contract Probes ===");

        // Known Monad DEX addresses — use uint160 to avoid checksum issues with guessed addrs
        _probeAddress(address(uint160(0x9BdcF5873E6f1702C75F0fd4B2FbaBe0A4095185)), "Kuru Router (guessed)");
        _probeAddress(address(uint160(0x268440d16C0f6f5E4E0b5BF5A89E8c47e3f4f7a8)), "Bean Router (guessed)");
        _probeAddress(address(uint160(0xaaAa44272Dc658575ba38F43C438447fdeD32D86)), "Ambient CrocSwapDex");
        _probeAddress(0x1111111254EEB25477B68fb85Ed929f73A960582, "1inch Aggregator");
    }

    function _probeAddress(address addr, string memory label) internal view {
        uint256 size;
        assembly { size := extcodesize(addr) }
        if (size > 0) {
            console.log("  EXISTS:", label);
            console.log("    addr:", addr);
            console.log("    code:", size);
        } else {
            console.log("  EMPTY:", label);
            console.log("    addr:", addr);
        }
    }
}

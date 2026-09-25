// Uniswap v4 PoolManager events (external protocol, not generated from our forge artifacts).
// Source: v4-core IPoolManager. Swap layout and sign convention verified against mainnet
// SIGHT/FEED buyback txs (docs/VERIFICATION-market.md): amounts are the swapper's deltas.
import { toEventSelector } from 'viem';

export const v4SwapEvent = {
  type: 'event',
  name: 'Swap',
  inputs: [
    { name: 'id', type: 'bytes32', indexed: true },
    { name: 'sender', type: 'address', indexed: true },
    { name: 'amount0', type: 'int128', indexed: false },
    { name: 'amount1', type: 'int128', indexed: false },
    { name: 'sqrtPriceX96', type: 'uint160', indexed: false },
    { name: 'liquidity', type: 'uint128', indexed: false },
    { name: 'tick', type: 'int24', indexed: false },
    { name: 'fee', type: 'uint24', indexed: false },
  ],
} as const;

export const v4InitializeEvent = {
  type: 'event',
  name: 'Initialize',
  inputs: [
    { name: 'id', type: 'bytes32', indexed: true },
    { name: 'currency0', type: 'address', indexed: true },
    { name: 'currency1', type: 'address', indexed: true },
    { name: 'fee', type: 'uint24', indexed: false },
    { name: 'tickSpacing', type: 'int24', indexed: false },
    { name: 'hooks', type: 'address', indexed: false },
    { name: 'sqrtPriceX96', type: 'uint160', indexed: false },
    { name: 'tick', type: 'int24', indexed: false },
  ],
} as const;

export const poolManagerEvents = [v4SwapEvent, v4InitializeEvent] as const;
export const SWAP_TOPIC = toEventSelector(v4SwapEvent);
export const INITIALIZE_TOPIC = toEventSelector(v4InitializeEvent);

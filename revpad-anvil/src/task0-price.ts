// Task 0 — Measure real launch price and verify START_MCAP_USD=10000 is correct.
// Buys exactly 1 USDC of tokens, computes implied price and FDV, compares to expected.
// Usage: npm run task0
import { ADDRESSES } from '@whetstone-research/doppler-sdk/evm';
import {
  concat,
  encodeAbiParameters,
  formatUnits,
  keccak256,
  maxUint160,
  maxUint256,
  parseUnits,
  type Address,
  type Hex,
} from 'viem';
import {
  CHAIN_ID,
  START_MCAP_USD,
  SUPPLY,
  USDC,
  account,
  assertFork,
  balanceOf,
  erc20Abi,
  loadState,
  pass,
  publicClient,
  testClient,
  wallet,
} from './env.js';

// ---- Uniswap v4 constants (same as 03-trade.ts) ----
const SWAP_EXACT_IN_SINGLE = 0x06;
const SETTLE_ALL = 0x0c;
const TAKE_ALL = 0x0f;
const V4_SWAP = '0x10' as Hex;

type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };

function encodeSwap(key: PoolKey, tokenIn: Address, amountIn: bigint): Hex {
  const zeroForOne = tokenIn.toLowerCase() === key.currency0.toLowerCase();
  const tokenOut = zeroForOne ? key.currency1 : key.currency0;
  const actions = concat([
    `0x${SWAP_EXACT_IN_SINGLE.toString(16).padStart(2, '0')}`,
    `0x${SETTLE_ALL.toString(16).padStart(2, '0')}`,
    `0x${TAKE_ALL.toString(16).padStart(2, '0')}`,
  ] as Hex[]);
  const swapParams = encodeAbiParameters(
    [{
      type: 'tuple',
      components: [
        { name: 'poolKey', type: 'tuple', components: [
          { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
          { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
        ] },
        { name: 'zeroForOne', type: 'bool' },
        { name: 'amountIn', type: 'uint128' },
        { name: 'amountOutMinimum', type: 'uint128' },
        { name: 'hookData', type: 'bytes' },
      ],
    }],
    [{ poolKey: key, zeroForOne, amountIn, amountOutMinimum: 0n, hookData: '0x' }],
  );
  const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [tokenIn, amountIn]);
  const take = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [tokenOut, 0n]);
  return encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, [swapParams, settle, take]]);
}

// Fund an address with USDC by writing to its storage slot directly (no deal()).
// USDC on Monad uses ERC20 storage layout with balances at slot 9 (confirmed in fork tests).
async function dealUsdc(addr: Address, amount: bigint) {
  const slot = keccak256(
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [addr, 9n]),
  );
  await testClient.setStorageAt({ address: USDC, index: slot, value: `0x${amount.toString(16).padStart(64, '0')}` as Hex });
}

async function swap(key: PoolKey, tokenIn: Address, amountIn: bigint) {
  const a = (ADDRESSES as unknown as Record<number, Record<string, Address>>)[CHAIN_ID];
  const w = wallet('trader');
  const ur = a.universalRouter;
  const permit2 = a.permit2;

  await w.waitForTransactionReceipt({
    hash: await w.writeContract({ address: tokenIn, abi: erc20Abi, functionName: 'approve', args: [permit2, maxUint256] }),
  });
  const exp = Math.floor(Date.now() / 1000) + 10 * 365 * 86_400;
  await w.waitForTransactionReceipt({
    hash: await w.writeContract({ address: permit2, abi: [
      { type: 'function', name: 'approve', stateMutability: 'nonpayable',
        inputs: [{ name: 'token', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }],
        outputs: [] },
    ] as const, functionName: 'approve', args: [tokenIn, ur, maxUint160, exp] }),
  });

  const input = encodeSwap(key, tokenIn, amountIn);
  const block = await publicClient.getBlock();
  const deadline = block.timestamp + 600n;
  const gas = await publicClient.estimateContractGas({
    account: w.account,
    address: ur,
    abi: [{ type: 'function', name: 'execute', stateMutability: 'payable',
      inputs: [{ name: 'commands', type: 'bytes' }, { name: 'inputs', type: 'bytes[]' }, { name: 'deadline', type: 'uint256' }],
      outputs: [] }] as const,
    functionName: 'execute',
    args: [V4_SWAP, [input], deadline],
  });
  const hash = await wallet('trader').writeContract({
    address: ur,
    abi: [{ type: 'function', name: 'execute', stateMutability: 'payable',
      inputs: [{ name: 'commands', type: 'bytes' }, { name: 'inputs', type: 'bytes[]' }, { name: 'deadline', type: 'uint256' }],
      outputs: [] }] as const,
    functionName: 'execute',
    args: [V4_SWAP, [input], deadline],
    gas: (gas * 11n) / 10n,
  });
  const r = await wallet('trader').waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`swap reverted: ${hash}`);
  return r;
}

async function main() {
  await assertFork();
  const st = loadState();
  if (!st.token || !st.poolKey) throw new Error('Run npm run launch first');

  const trader = account('trader').address;
  const BUY_USDC = parseUnits('1', 6); // exactly 1 USDC

  // Fund the trader with 10 USDC via direct storage write (avoids deal() fork-backend issues)
  await dealUsdc(trader, parseUnits('10', 6));
  const usdcBefore = await balanceOf(USDC, trader);
  pass(usdcBefore >= BUY_USDC, 'trader funded with USDC', formatUnits(usdcBefore, 6));

  const tokBefore = await balanceOf(st.token, trader);

  console.log(`\nBuying ${formatUnits(BUY_USDC, 6)} USDC of tokens...`);
  await swap(st.poolKey, USDC, BUY_USDC);

  const tokAfter = await balanceOf(st.token, trader);
  const received = tokAfter - tokBefore;
  pass(received > 0n, 'received tokens', formatUnits(received, 18));

  // ---- Price analysis ----
  // received tokens (18 decimals), paid 1 USDC (6 decimals)
  // implied_price = 1 USDC / received_tokens  (in $/token)
  // implied_fdv   = implied_price * SUPPLY
  //
  // Use fixed-point: price_e24 = 1e6 * 1e18 / received  (price in USDC units × 1e18)
  // This avoids floats entirely; then compare to expected.

  // Price = USDC_paid / tokens_received  (both in human units)
  // USDC_paid   = 1_000_000 raw units / 10^6 = 1 USDC
  // tokens_human = received / 10^18
  // price_usd = (1_000_000 / 10^6) / (received / 10^18) = 10^12 / received_raw
  // FDV_raw (micro-USDC) = price_usd * SUPPLY / 10^12  ... avoid overflow:
  //   FDV_raw = (1_000_000 * SUPPLY) / received   [in micro-USDC]
  const impliedFdvRaw = (1_000_000n * SUPPLY) / received; // micro-USDC (6 dec)
  const impliedFdvUsdc = Number(impliedFdvRaw) / 1e6;

  // Price in USD per token (floating point for display only)
  const priceUsd = 1.0 / (Number(received) / 1e18);

  const expectedFdv = START_MCAP_USD; // 10000
  const ratio = impliedFdvUsdc / expectedFdv;

  console.log('\n=== Task 0 Price Report ===');
  console.log(`  USDC paid          : 1.000000`);
  console.log(`  Tokens received    : ${formatUnits(received, 18)}`);
  console.log(`  Implied price      : $${priceUsd.toExponential(4)} per token`);
  console.log(`  Implied FDV        : $${impliedFdvUsdc.toFixed(2)}`);
  console.log(`  Expected FDV       : $${expectedFdv.toFixed(2)} (START_MCAP_USD)`);
  console.log(`  Ratio actual/expected: ${ratio.toFixed(3)}x`);

  const ok = ratio >= 0.5 && ratio <= 2.0;
  pass(ok, 'implied FDV within 2x of START_MCAP_USD', `${impliedFdvUsdc.toFixed(2)} vs ${expectedFdv}`);

  if (!ok) {
    console.log('\nDIAGNOSIS:');
    if (ratio < 0.1) {
      console.log(`  Price is ~${(1 / ratio).toFixed(0)}x TOO CHEAP.`);
      console.log('  Likely cause: numerairePrice in withCurves is too small.');
      console.log('  - If numerairePrice expects USD (1 = $1): current value 1 is correct.');
      console.log('  - If marketCap.start is interpreted in raw numeraire units (micro-USDC),');
      console.log('    then 10000 means $0.01 target FDV → price is 1000x too low.');
      console.log('  - Fix candidate: marketCap: { start: START_MCAP_USD * 1e6, end: START_MCAP_USD * 20 * 1e6 }');
      console.log('    ... but verify Doppler SDK docs for the correct unit.');
    } else if (ratio > 10) {
      console.log(`  Price is ~${ratio.toFixed(0)}x TOO EXPENSIVE.`);
      console.log('  Likely cause: numerairePrice or marketCap values are too large.');
    }
  } else {
    console.log('\nPrice is correct. START_MCAP_USD=10000 launches at the right price.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

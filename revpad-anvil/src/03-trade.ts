// Test 03 — trade through the pool (Universal Router V4_SWAP) to generate fees in both currencies.
// Usage: npm run trade -- [buyUsdc=50]
import { ADDRESSES } from '@whetstone-research/doppler-sdk/evm';
import { concat, encodeAbiParameters, formatUnits, maxUint160, maxUint256, parseUnits, type Address, type Hex } from 'viem';
import { CHAIN_ID, USDC, account, assertFork, balanceOf, erc20Abi, loadState, pass, publicClient, saveState, wallet } from './env.js';

const permit2Abi = [
  {
    type: 'function', name: 'approve', stateMutability: 'nonpayable',
    inputs: [{ name: 'token', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }],
    outputs: [],
  },
] as const;
const urAbi = [
  {
    type: 'function', name: 'execute', stateMutability: 'payable',
    inputs: [{ name: 'commands', type: 'bytes' }, { name: 'inputs', type: 'bytes[]' }, { name: 'deadline', type: 'uint256' }],
    outputs: [],
  },
] as const;

// Uniswap v4 action / command ids (verified against @uniswap/v4-sdk 2.4.0 and universal-router-sdk 5.12.0)
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

async function swap(key: PoolKey, tokenIn: Address, amountIn: bigint) {
  const a = (ADDRESSES as unknown as Record<number, Record<string, Address>>)[CHAIN_ID];
  const w = wallet('trader');
  const ur = a.universalRouter;
  const permit2 = a.permit2;

  await w.waitForTransactionReceipt({ hash: await w.writeContract({ address: tokenIn, abi: erc20Abi, functionName: 'approve', args: [permit2, maxUint256] }) });
  const exp = Math.floor(Date.now() / 1000) + 10 * 365 * 86_400;
  await w.waitForTransactionReceipt({ hash: await w.writeContract({ address: permit2, abi: permit2Abi, functionName: 'approve', args: [tokenIn, ur, maxUint160, exp] }) });

  const input = encodeSwap(key, tokenIn, amountIn);
  const block = await publicClient.getBlock();
  const deadline = block.timestamp + 600n;
  const gas = await publicClient.estimateContractGas({ account: w.account, address: ur, abi: urAbi, functionName: 'execute', args: [V4_SWAP, [input], deadline] });
  const hash = await w.writeContract({ address: ur, abi: urAbi, functionName: 'execute', args: [V4_SWAP, [input], deadline], gas: (gas * 11n) / 10n });
  const r = await w.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`swap reverted: ${hash}`);
  return r;
}

async function main() {
  await assertFork();
  const st = loadState();
  if (!st.token || !st.poolKey) throw new Error('Run npm run launch first');
  const trader = account('trader').address;
  const buyUsdc = parseUnits(process.argv[2] ?? '50', 6);

  const usdc0 = await balanceOf(USDC, trader);
  if (usdc0 < buyUsdc) throw new Error(`Trader has ${formatUnits(usdc0, 6)} USDC; run the "fund" task first`);
  const tok0 = await balanceOf(st.token, trader);

  console.log(`BUY with ${formatUnits(buyUsdc, 6)} USDC`);
  await swap(st.poolKey, USDC, buyUsdc);
  const tok1 = await balanceOf(st.token, trader);
  const bought = tok1 - tok0;
  pass(bought > 0n, 'received tokens', formatUnits(bought, 18));

  const sellAmt = bought / 2n;
  console.log(`SELL ${formatUnits(sellAmt, 18)} tokens`);
  const usdcBeforeSell = await balanceOf(USDC, trader);
  await swap(st.poolKey, st.token, sellAmt);
  const usdcAfterSell = await balanceOf(USDC, trader);
  pass(usdcAfterSell > usdcBeforeSell, 'received USDC', formatUnits(usdcAfterSell - usdcBeforeSell, 6));

  const buyVol = BigInt(st.buyVolumeUsdc ?? '0') + buyUsdc;
  const sellVol = BigInt(st.sellVolumeToken ?? '0') + sellAmt;
  saveState({ buyVolumeUsdc: buyVol.toString(), sellVolumeToken: sellVol.toString() });
  console.log(`\nCumulative: buys ${formatUnits(buyVol, 6)} USDC, sells ${formatUnits(sellVol, 18)} tokens.`);
  console.log(`Expected fees: ~${formatUnits((buyVol * 2n) / 100n, 6)} USDC + ~${formatUnits((sellVol * 2n) / 100n, 18)} tokens. Next: npm run fees`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

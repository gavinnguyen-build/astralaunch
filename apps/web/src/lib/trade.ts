/**
 * Buy / Sell through the Uniswap Universal Router + Permit2 (CLAUDE.md rule 13: user wallets only).
 * Framework-free (browser + fork test runner).
 *
 * Pool key: BuybackVault.getPoolKey(asset) (on-chain). Quote: v4 Quoter quoteExactInputSingle.
 * minOut = quote × (1 − slippage), default 1%. Every tx is simulated first; gas = estimate × 1.1.
 *
 *   Buy, USDC pair : [PERMIT2_PERMIT] V4_SWAP{ SWAP_EXACT_IN_SINGLE, SETTLE_ALL(USDC), TAKE_ALL(token, minOut) }
 *   Buy, MON pair  : WRAP_ETH(router, amountIn) V4_SWAP{ SWAP, SETTLE(WMON, open delta, payer = router), TAKE_ALL(token) }
 *                    → the user pays native MON; it is wrapped in the same transaction.
 *   Sell, USDC pair: [PERMIT2_PERMIT] V4_SWAP{ SWAP, SETTLE_ALL(token), TAKE_ALL(USDC, minOut) }
 *   Sell, MON pair : [PERMIT2_PERMIT] V4_SWAP{ SWAP, SETTLE_ALL(token), TAKE(WMON → router) } UNWRAP_WETH(user, minOut)
 * ERC-20 inputs need an ERC-20 approval of Permit2 (exact amount, only when the allowance is short).
 */
import {
  concatHex, encodeAbiParameters, encodeFunctionData, getAddress, maxUint48, parseAbiParameters, toHex,
  type Address, type Hex, type PublicClient, type WalletClient,
} from 'viem';
import { withBuffer } from '@astralaunch/shared';

export interface TradeAddrs {
  universalRouter: Address; permit2: Address; quoter: Address; vault: Address; wmon: Address; usdc: Address;
}
export type UrVersion = '2.0' | '2.1.1';
export interface PoolKey { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }

const vaultAbi = [{ type: 'function', name: 'getPoolKey', stateMutability: 'view', inputs: [{ name: 'asset', type: 'address' }],
  outputs: [{ type: 'tuple', components: [
    { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' },
    { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] }] }] as const;
const quoterAbi = [{ type: 'function', name: 'quoteExactInputSingle', stateMutability: 'nonpayable',
  inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'poolKey', type: 'tuple', components: [
      { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' },
      { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] },
    { name: 'zeroForOne', type: 'bool' }, { name: 'exactAmount', type: 'uint128' }, { name: 'hookData', type: 'bytes' }] }],
  outputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'gasEstimate', type: 'uint256' }] }] as const;
const erc20Abi = [
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;
const permit2Abi = [{ type: 'function', name: 'allowance', stateMutability: 'view',
  inputs: [{ type: 'address' }, { type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint160' }, { type: 'uint48' }, { type: 'uint48' }] }] as const;
const urAbi = [{ type: 'function', name: 'execute', stateMutability: 'payable',
  inputs: [{ name: 'commands', type: 'bytes' }, { name: 'inputs', type: 'bytes[]' }, { name: 'deadline', type: 'uint256' }], outputs: [] }] as const;

// Universal Router commands / v4 actions (v4-periphery Actions, UR Commands).
const CMD = { PERMIT2_PERMIT: 0x0a, WRAP_ETH: 0x0b, UNWRAP_WETH: 0x0c, V4_SWAP: 0x10 } as const;
const ACT = { SWAP_EXACT_IN_SINGLE: 0x06, SETTLE: 0x0b, SETTLE_ALL: 0x0c, TAKE: 0x0e, TAKE_ALL: 0x0f } as const;
const MSG_SENDER = '0x0000000000000000000000000000000000000001';   // ActionConstants.MSG_SENDER
const ADDRESS_THIS = '0x0000000000000000000000000000000000000002'; // ActionConstants.ADDRESS_THIS
const OPEN_DELTA = 0n;                                               // ActionConstants.OPEN_DELTA
const POOL_KEY = '(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';

export async function getPoolKey(pc: PublicClient, a: TradeAddrs, asset: Address): Promise<PoolKey> {
  const k = await pc.readContract({ address: a.vault, abi: vaultAbi, functionName: 'getPoolKey', args: [asset] });
  if (k.currency0 === '0x0000000000000000000000000000000000000000' && k.currency1 === '0x0000000000000000000000000000000000000000') {
    throw new Error('No pool key for this token in the BuybackVault.');
  }
  return { currency0: k.currency0, currency1: k.currency1, fee: Number(k.fee), tickSpacing: Number(k.tickSpacing), hooks: k.hooks };
}

export async function quote(pc: PublicClient, a: TradeAddrs, key: PoolKey, zeroForOne: boolean, amountIn: bigint): Promise<bigint> {
  const { result } = await pc.simulateContract({
    address: a.quoter, abi: quoterAbi, functionName: 'quoteExactInputSingle',
    args: [{ poolKey: key, zeroForOne, exactAmount: amountIn, hookData: '0x' }],
  });
  return result[0];
}

function swapParam(v: UrVersion, key: PoolKey, zeroForOne: boolean, amountIn: bigint, minOut: bigint): Hex {
  return v === '2.1.1'
    ? encodeAbiParameters(parseAbiParameters(`(${POOL_KEY} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 maxHopSlippage,bytes hookData)`),
        [{ poolKey: key, zeroForOne, amountIn, amountOutMinimum: minOut, maxHopSlippage: 0n, hookData: '0x' }])
    : encodeAbiParameters(parseAbiParameters(`(${POOL_KEY} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)`),
        [{ poolKey: key, zeroForOne, amountIn, amountOutMinimum: minOut, hookData: '0x' }]);
}
const v4Swap = (actions: number[], params: Hex[]) =>
  encodeAbiParameters(parseAbiParameters('bytes actions, bytes[] params'), [toHex(new Uint8Array(actions)), params]);
const enc = (types: string, values: unknown[]) => encodeAbiParameters(parseAbiParameters(types), values as never);

export interface TradeRequest {
  side: 'buy' | 'sell';
  asset: Address;
  amountIn: bigint;          // buy: USDC (6 dp) or MON (18 dp); sell: token (18 dp)
  slippageBps?: number;      // default 100 = 1%
  urVersion?: UrVersion;
}

export interface TradePlan {
  side: 'buy' | 'sell'; asset: Address; key: PoolKey; numeraire: Address; isMonPair: boolean; zeroForOne: boolean;
  inputToken: Address | 'MON'; outputToken: Address | 'MON'; amountIn: bigint; quoteOut: bigint; minOut: bigint; slippageBps: number;
  needsApproval: boolean; needsPermit: boolean; permitNonce: number; balanceIn: bigint;
}

export type TradeQuote = Omit<TradePlan, 'needsApproval' | 'needsPermit' | 'permitNonce' | 'balanceIn'> & {
  /** Execution price vs the pool's marginal price, in bps (the 2% fee cancels out). */
  priceImpactBps: number;
};

/** Quote only: no account needed (the swap panel quotes before a wallet is connected). */
export async function quoteTrade(pc: PublicClient, a: TradeAddrs, r: TradeRequest & { key?: PoolKey }): Promise<TradeQuote> {
  const key = r.key ?? await getPoolKey(pc, a, r.asset);
  const asset = getAddress(r.asset);
  const numeraire = getAddress(key.currency0) === asset ? getAddress(key.currency1) : getAddress(key.currency0);
  const isMonPair = numeraire === getAddress(a.wmon);
  const tokenIn = r.side === 'buy' ? numeraire : asset;
  const zeroForOne = getAddress(key.currency0) === tokenIn;
  const slippageBps = r.slippageBps ?? 100;
  const refIn = r.amountIn / 1000n > 0n ? r.amountIn / 1000n : 1n;
  const [quoteOut, refOut] = await Promise.all([quote(pc, a, key, zeroForOne, r.amountIn), quote(pc, a, key, zeroForOne, refIn)]);
  const minOut = (quoteOut * BigInt(10_000 - slippageBps)) / 10_000n;
  const impact = refOut > 0n ? 10_000n - (quoteOut * refIn * 10_000n) / (r.amountIn * refOut) : 0n;
  return {
    side: r.side, asset, key, numeraire, isMonPair, zeroForOne,
    inputToken: r.side === 'buy' && isMonPair ? 'MON' : tokenIn,
    outputToken: r.side === 'sell' && isMonPair ? 'MON' : r.side === 'buy' ? asset : numeraire,
    amountIn: r.amountIn, quoteOut, minOut, slippageBps, priceImpactBps: Number(impact > 0n ? impact : 0n),
  };
}

/** Balance + ERC-20 → Permit2 allowance + Permit2 → router allowance for a quote. */
export async function accountState(pc: PublicClient, a: TradeAddrs, account: Address, q: Pick<TradeQuote, 'inputToken' | 'amountIn'>) {
  if (q.inputToken === 'MON') return { balanceIn: await pc.getBalance({ address: account }), needsApproval: false, needsPermit: false, permitNonce: 0 };
  const tokenIn = q.inputToken;
  const [balanceIn, allow, [amt, exp, nonce]] = await Promise.all([
    pc.readContract({ address: tokenIn, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    pc.readContract({ address: tokenIn, abi: erc20Abi, functionName: 'allowance', args: [account, a.permit2] }),
    pc.readContract({ address: a.permit2, abi: permit2Abi, functionName: 'allowance', args: [account, tokenIn, a.universalRouter] }),
  ]);
  return {
    balanceIn,
    needsApproval: allow < q.amountIn,
    needsPermit: amt < q.amountIn || Number(exp) <= Math.floor(Date.now() / 1000) + 60,
    permitNonce: Number(nonce),
  };
}

/** Quote + allowance/balance checks. No transaction. */
export async function planTrade(pc: PublicClient, a: TradeAddrs, account: Address, r: TradeRequest): Promise<TradePlan> {
  const q = await quoteTrade(pc, a, r);
  return { ...q, ...(await accountState(pc, a, account, q)) };
}

/** Permit2 PermitSingle for the Universal Router (EIP-712, signed by the wallet). */
async function signPermit(wc: WalletClient, account: Address, a: TradeAddrs, chainId: number, token: Address, amount: bigint, nonce: number) {
  const now = Math.floor(Date.now() / 1000);
  const details = { token, amount, expiration: now + 1800, nonce };
  const sigDeadline = BigInt(now + 1800);
  const signature = await wc.signTypedData({
    account,
    domain: { name: 'Permit2', chainId, verifyingContract: a.permit2 },
    types: {
      PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }],
      PermitSingle: [{ name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }],
    },
    primaryType: 'PermitSingle',
    message: { details, spender: a.universalRouter, sigDeadline },
  });
  if (details.expiration > Number(maxUint48)) throw new Error('bad expiration');
  return enc('((address token,uint160 amount,uint48 expiration,uint48 nonce) details,address spender,uint256 sigDeadline), bytes', [
    { details, spender: a.universalRouter, sigDeadline }, signature]);
}

/** Build Universal Router execute() calldata + value for a planned trade. */
export async function buildTradeTx(wc: WalletClient, account: Address, a: TradeAddrs, chainId: number, p: TradePlan, v: UrVersion = '2.0') {
  const cmds: number[] = [];
  const inputs: Hex[] = [];
  const swap = swapParam(v, p.key, p.zeroForOne, p.amountIn, p.side === 'sell' && p.isMonPair ? 0n : p.minOut);
  const tokenIn = p.side === 'buy' ? p.numeraire : p.asset;
  const tokenOut = p.side === 'buy' ? p.asset : p.numeraire;
  let value = 0n;
  if (p.side === 'buy' && p.isMonPair) {
    cmds.push(CMD.WRAP_ETH); inputs.push(enc('address, uint256', [ADDRESS_THIS, p.amountIn]));
    cmds.push(CMD.V4_SWAP); inputs.push(v4Swap(
      [ACT.SWAP_EXACT_IN_SINGLE, ACT.SETTLE, ACT.TAKE_ALL],
      [swap, enc('address, uint256, bool', [p.numeraire, OPEN_DELTA, false]), enc('address, uint256', [tokenOut, p.minOut])],
    ));
    value = p.amountIn;
  } else {
    if (p.needsPermit) {
      cmds.push(CMD.PERMIT2_PERMIT);
      inputs.push(await signPermit(wc, account, a, chainId, tokenIn, p.amountIn, p.permitNonce));
    }
    if (p.side === 'sell' && p.isMonPair) {
      cmds.push(CMD.V4_SWAP); inputs.push(v4Swap(
        [ACT.SWAP_EXACT_IN_SINGLE, ACT.SETTLE_ALL, ACT.TAKE],
        [swap, enc('address, uint256', [tokenIn, p.amountIn]), enc('address, address, uint256', [p.numeraire, ADDRESS_THIS, OPEN_DELTA])],
      ));
      cmds.push(CMD.UNWRAP_WETH); inputs.push(enc('address, uint256', [MSG_SENDER, p.minOut]));
    } else {
      cmds.push(CMD.V4_SWAP); inputs.push(v4Swap(
        [ACT.SWAP_EXACT_IN_SINGLE, ACT.SETTLE_ALL, ACT.TAKE_ALL],
        [swap, enc('address, uint256', [tokenIn, p.amountIn]), enc('address, uint256', [tokenOut, p.minOut])],
      ));
    }
  }
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
  const data = encodeFunctionData({ abi: urAbi, functionName: 'execute', args: [concatHex(cmds.map((c) => toHex(c, { size: 1 }))), inputs, deadline] });
  return { to: a.universalRouter, data, value };
}

/** ERC-20 approval of Permit2 for exactly the trade amount (simulated, gas × 1.1). */
export async function approvePermit2(pc: PublicClient, wc: WalletClient, account: Address, a: TradeAddrs, token: Address, amount: bigint) {
  const { request } = await pc.simulateContract({ account, address: token, abi: erc20Abi, functionName: 'approve', args: [a.permit2, amount] });
  const gas = await pc.estimateContractGas({ account, address: token, abi: erc20Abi, functionName: 'approve', args: [a.permit2, amount] });
  const hash = await wc.writeContract({ ...request, chain: wc.chain ?? null, gas: withBuffer(gas) });
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`Approval reverted (${hash})`);
  return hash;
}

/** Simulate (eth_call + gas estimate) then send the swap with gas = estimate × 1.1. */
export async function simulateTrade(pc: PublicClient, account: Address, tx: { to: Address; data: Hex; value: bigint }) {
  await pc.call({ account, to: tx.to, data: tx.data, value: tx.value });
  const gas = await pc.estimateGas({ account, to: tx.to, data: tx.data, value: tx.value });
  return withBuffer(gas);
}

export async function sendTrade(pc: PublicClient, wc: WalletClient, account: Address, tx: { to: Address; data: Hex; value: bigint }, gas: bigint) {
  const hash = await wc.sendTransaction({ account, chain: wc.chain ?? null, to: tx.to, data: tx.data, value: tx.value, gas });
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`Swap reverted (${hash})`);
  return { hash, receipt: r };
}

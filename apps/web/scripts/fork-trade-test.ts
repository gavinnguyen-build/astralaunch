/**
 * Fork test for lib/trade.ts against the real Universal Router, Permit2, v4 Quoter and the SIGHT
 * (USDC) / FEED (MON) pools. LOCAL Anvil fork only.
 *   ANVIL_RPC=http://127.0.0.1:8545 tsx --env-file=<keys.env with AGENT_PRIVATE_KEY> scripts/fork-trade-test.ts
 */
import { createPublicClient, createWalletClient, defineChain, formatUnits, http, parseUnits, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PERMIT2, UNIVERSAL_ROUTER, USDC, V4_QUOTER, WMON } from '@astralaunch/shared';
import { approvePermit2, buildTradeTx, planTrade, sendTrade, simulateTrade, type TradeAddrs, type UrVersion } from '../src/lib/trade.js';

const RPC = process.env.ANVIL_RPC ?? 'http://127.0.0.1:8545';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(RPC)) throw new Error('fork only');
const chain = defineChain({ id: 143, name: 'fork', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as Hex);
const pc = createPublicClient({ chain, transport: http(RPC) });
const wc = createWalletClient({ account, chain, transport: http(RPC) });
const vault = process.env.VAULT as Address ?? '0x394F1dcA6011C16BC6e70CA13F6F29767D92171E';
const A: TradeAddrs = { universalRouter: UNIVERSAL_ROUTER, permit2: PERMIT2, quoter: V4_QUOTER, vault, wmon: WMON, usdc: USDC };
const SIGHT = '0x30Ae380593A04C14aBFa994969B718a78A6105aD' as Address;
const FEED = '0x2686619d5569AEbcdfeC774e8a2167dE78376dDf' as Address;
const bal = async (t: Address | 'MON') => t === 'MON' ? pc.getBalance({ address: account.address })
  : pc.readContract({ address: t, abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }], functionName: 'balanceOf', args: [account.address] });
const log = (s: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);

let ur: UrVersion = '2.0';
async function trade(label: string, side: 'buy' | 'sell', asset: Address, amountIn: bigint) {
  log(`===== ${label}`);
  const p = await planTrade(pc as never, A, account.address, { side, asset, amountIn });
  const dIn = p.inputToken === 'MON' || p.side === 'sell' ? 18 : 6;
  const dOut = p.side === 'buy' ? 18 : p.outputToken === 'MON' ? 18 : 6;
  log(`plan: in ${formatUnits(p.amountIn, dIn)} ${p.inputToken === 'MON' ? 'MON' : p.inputToken} → quote ${formatUnits(p.quoteOut, dOut)} min ${formatUnits(p.minOut, dOut)} (${p.slippageBps / 100}% slippage) approval=${p.needsApproval} permit=${p.needsPermit}`);
  if (p.needsApproval) log(`approve Permit2: ${await approvePermit2(pc as never, wc, account.address, A, p.inputToken as Address, p.amountIn)}`);
  const beforeOut = await bal(p.outputToken);
  let tx = await buildTradeTx(wc, account.address, A, 143, p, ur);
  let gas: bigint;
  try { gas = await simulateTrade(pc as never, account.address, tx); }
  catch (e) {
    if (ur === '2.0') {
      log(`UR 2.0 encoding reverted in simulation (${(e as Error).message.split('\n')[0].slice(0, 120)}); trying 2.1.1`);
      ur = '2.1.1'; tx = await buildTradeTx(wc, account.address, A, 143, { ...p, needsPermit: p.needsPermit }, ur);
      gas = await simulateTrade(pc as never, account.address, tx);
    } else throw e;
  }
  const { hash, receipt } = await sendTrade(pc as never, wc, account.address, tx, gas);
  const got = (await bal(p.outputToken)) - beforeOut;
  log(`sent ${hash} status ${receipt.status} gasUsed ${receipt.gasUsed} (limit ${gas}) · received ${formatUnits(got, dOut)} ${p.outputToken === 'MON' ? 'MON (≈, minus gas)' : ''} · ≥ min: ${got >= p.minOut || p.outputToken === 'MON'}`);
  return got;
}

const s1 = await trade('buy SIGHT with 1 USDC', 'buy', SIGHT, parseUnits('1', 6));
await trade('sell half the SIGHT for USDC', 'sell', SIGHT, s1 / 2n);
const f1 = await trade('buy FEED paying 5 MON (wrapped in the same tx)', 'buy', FEED, parseUnits('5', 18));
await trade('sell half the FEED for MON (unwrapped in the same tx)', 'sell', FEED, f1 / 2n);
log(`UR encoding that works on Monad: ${ur}`);

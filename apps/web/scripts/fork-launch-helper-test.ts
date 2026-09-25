/**
 * Fork test for the ONE-transaction launch (src/lib/launch.ts helper mode) against a local Anvil fork
 * with LaunchHelper deployed, the server (LAUNCH_HELPER_ADDRESS set) and the indexer running.
 * Counts what the wallet is actually asked for (transactions, signatures) and checks the treasury,
 * listing and the saved token details / service. Local Anvil fork ONLY.
 *
 *   ANVIL_RPC=http://127.0.0.1:8546 API=http://127.0.0.1:3102 ../server/node_modules/.bin/tsx scripts/fork-launch-helper-test.ts
 */
import { createPublicClient, createWalletClient, defineChain, formatEther, http, type Hex, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { executeLaunch, feeStatus, fmtMon, LaunchError, planLaunch, type ChainConfig, type Ctx, type LaunchInput } from '../src/lib/launch.js';

const RPC = process.env.ANVIL_RPC ?? 'http://127.0.0.1:8546';
const API = process.env.API ?? 'http://127.0.0.1:3102';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(RPC)) throw new Error(`Refusing non-local RPC ${RPC}: fork only.`);

const config = await (await fetch(`${API}/api/config`)).json() as ChainConfig;
if (!config.launchHelper) throw new Error('/api/config has no launchHelper: start the server with LAUNCH_HELPER_ADDRESS.');
const chain = defineChain({ id: config.chainId, name: 'Monad fork', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
// Anvil #0: fork-only test key, never used on mainnet.
const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const baseWallet = createWalletClient({ account, chain, transport: http(RPC) });

// Count what the user's wallet would be asked to do.
const asked = { tx: 0, sig: 0 };
const walletClient = new Proxy(baseWallet, {
  get(t, k, r) {
    const v = Reflect.get(t, k, r);
    if (k === 'writeContract' || k === 'sendTransaction') return (...a: unknown[]) => { asked.tx++; return (v as (...x: unknown[]) => unknown).apply(t, a); };
    if (k === 'signMessage') return (...a: unknown[]) => { asked.sig++; return (v as (...x: unknown[]) => unknown).apply(t, a); };
    return v;
  },
}) as WalletClient;
const ctx: Ctx = { publicClient: publicClient as never, walletClient, account: account.address, apiBase: API, config };

let mining = true;   // fork-only: mine so "finalized" (≈ head − 64 on Anvil) catches up quickly
(async () => { while (mining) { await publicClient.request({ method: 'anvil_mine' as never, params: ['0x8'] as never }).catch(() => {}); await new Promise((r) => setTimeout(r, 400)); } })();

const log = (s: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
let failures = 0;
const check = (ok: boolean, what: string) => { log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failures++; };
const treasury = () => publicClient.getBalance({ address: config.launchFee.treasury });

async function run(label: string, input: LaunchInput, expect: { tx: number; sig: number; fee: boolean }) {
  log(`===== ${label}`);
  const plan = await planLaunch(ctx, input);
  log(`plan: mode=${plan.mode} txs=${plan.txCount} signatures=${plan.signatureCount} fee=${plan.feeTx.needed ? fmtMon(plan.feeTx.valueWei) : `reusing ${plan.feeTx.reusingReceipt}`} gas=${plan.launchGas} est=${fmtMon(plan.estimatedMonCost)} predicted=${plan.predictedToken}`);
  check(plan.mode === 'helper' && plan.txCount === expect.tx && plan.signatureCount === expect.sig, `confirmation shows ${expect.tx} transaction / ${expect.sig} signature`);
  const t0 = await treasury();
  asked.tx = 0; asked.sig = 0;
  const res = await executeLaunch(ctx, input, plan, (step, state, info) => log(`  ${step.padEnd(8)} ${state}${info?.tx ? ` tx ${info.tx}` : ''}${info?.note ? ` (${info.note})` : ''}`));
  const paid = (await treasury()) - t0;
  log(`result: asset ${res.asset} router ${res.router} poolId ${res.poolId} listed=${res.listed} tx ${res.launchTx}${res.notes.length ? ` notes: ${res.notes.join(' | ')}` : ''}`);
  check(asked.tx === expect.tx && asked.sig === expect.sig, `wallet asked for ${asked.tx} transaction(s), ${asked.sig} signature(s)`);
  check(res.launchTx === res.registerTx && (expect.fee ? res.feeTx === res.launchTx : res.feeTx === null), 'create, register and fee are the same transaction');
  check(paid === (expect.fee ? BigInt(config.launchFee.wei) : 0n), `treasury received ${formatEther(paid)} MON`);
  check(res.listed, 'token listed by the indexer');
  return res;
}

try {
  const a = await run('USDC + metadata + service, one tx + one signature', {
    name: 'Helper Sight', symbol: 'HSIGHT', pairing: 'usdc', xHandle: 'helpersight', website: 'https://example.com',
    description: 'One-transaction launch',
    service: { slug: 'helper-sight', name: 'Helper Sight', upstreamUrl: 'http://127.0.0.1:4001', priceUsdc: 500_000n, description: 'sample' },
  }, { tx: 1, sig: 1, fee: true });
  const tok = await (await fetch(`${API}/api/tokens/${a.asset}`)).json() as { xHandle: string; website: string; service: { slug: string; priceUsdc: string } | null };
  check(tok.xHandle === 'helpersight' && tok.website === 'https://example.com' && tok.service?.slug === 'helper-sight' && tok.service?.priceUsdc === '500000',
    `API: @${tok.xHandle}, ${tok.website}, service ${tok.service?.slug} @ ${tok.service?.priceUsdc}`);

  await run('MON pairing, no details: one tx, no signature', { name: 'Helper Feed', symbol: 'HFEED', pairing: 'mon' }, { tx: 1, sig: 0, fee: true });

  log('===== fee paid directly earlier (old path), then a helper launch reuses it with value 0');
  const hash = await baseWallet.sendTransaction({ to: config.launchFee.treasury, value: BigInt(config.launchFee.wei), gas: 30_000n });
  await publicClient.waitForTransactionReceipt({ hash });
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${API}/api/launch-fee/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txHash: hash }) });
    if (r.status === 201) break;
    await new Promise((res) => setTimeout(res, 2_000));
  }
  check((await feeStatus(ctx)).unusedReceipts.length === 1, 'direct fee verified as an unused receipt');
  await run('helper launch reusing the receipt', { name: 'Helper Third', symbol: 'HTHIRD', pairing: 'usdc' }, { tx: 1, sig: 0, fee: false });

  log('===== fourth launch in 24h');
  try {
    await planLaunch(ctx, { name: 'Helper Fourth', symbol: 'H4', pairing: 'usdc' });
    check(false, 'fourth launch refused');
  } catch (e) {
    check(e instanceof LaunchError && e.code === 'rate_limited', `fourth launch refused before any tx: ${e instanceof Error ? e.message : e}`);
  }
} finally {
  mining = false;
}
log(failures ? `${failures} check(s) FAILED` : 'ALL CHECKS PASSED');
process.exitCode = failures ? 1 : 0;

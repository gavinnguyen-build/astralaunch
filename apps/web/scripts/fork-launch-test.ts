/**
 * Fork test for the browser launch flow (src/lib/launch.ts), run from Node with a local Anvil key.
 * Local Anvil fork ONLY (refuses any other RPC). Exercises: fee payment + verify, USDC and MON
 * launches with every tx simulated, register, listing by the indexer, signed metadata + service,
 * receipt reuse, and the 3-per-24h limit.
 *
 *   ANVIL_RPC=http://127.0.0.1:8545 API=http://127.0.0.1:3101 \
 *     pnpm exec tsx --env-file=<keys.env with CREATOR_PRIVATE_KEY> scripts/fork-launch-test.ts
 */
import { createPublicClient, createWalletClient, defineChain, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { executeLaunch, feeStatus, fmtMon, LaunchError, planLaunch, type ChainConfig, type Ctx, type LaunchInput } from '../src/lib/launch.js';

const RPC = process.env.ANVIL_RPC ?? 'http://127.0.0.1:8545';
const API = process.env.API ?? 'http://127.0.0.1:3101';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(RPC)) throw new Error(`Refusing non-local RPC ${RPC}: fork only.`);

const config = await (await fetch(`${API}/api/config`)).json() as ChainConfig;
const chain = defineChain({ id: config.chainId, name: 'Monad fork', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const account = privateKeyToAccount(process.env.CREATOR_PRIVATE_KEY as Hex);
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const walletClient = createWalletClient({ account, chain, transport: http(RPC) });
const ctx: Ctx = { publicClient: publicClient as never, walletClient, account: account.address, apiBase: API, config };

// Fork-only helper: mine blocks so "finalized" (≈ head − 64 on Anvil) catches up quickly.
let mining = true;
(async () => { while (mining) { await publicClient.request({ method: 'anvil_mine' as never, params: ['0x8'] as never }).catch(() => {}); await new Promise((r) => setTimeout(r, 400)); } })();

const log = (s: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
async function run(label: string, input: LaunchInput) {
  log(`===== ${label}`);
  const plan = await planLaunch(ctx, input);
  log(`plan: creator=${plan.creator} numeraire=${plan.numeraireSymbol} (${plan.oracleNote}) predicted=${plan.predictedToken}`);
  log(`plan: fee ${plan.feeTx.needed ? `${fmtMon(plan.feeTx.valueWei)} gas ${plan.feeTx.gas}` : `reusing ${plan.feeTx.reusingReceipt}`} · launch gas ${plan.launchGas} · est. total ${fmtMon(plan.estimatedMonCost)} · balance ${fmtMon(plan.monBalance)}`);
  log(`plan: beneficiaries ${plan.beneficiaries.map((b) => `${b.label}=${Number(b.shares) / 1e16}%`).join(', ')}`);
  const res = await executeLaunch(ctx, input, plan, (step, state, info) => log(`  ${step.padEnd(8)} ${state}${info?.tx ? ` tx ${info.tx}` : ''}${info?.note ? ` (${info.note})` : ''}`));
  log(`result: asset ${res.asset} router ${res.router} listed=${res.listed} launch ${res.launchTx} register ${res.registerTx}${res.notes.length ? ` notes: ${res.notes.join(' | ')}` : ''}`);
  return res;
}

try {
  const a = await run('USDC launch with metadata + service', {
    name: 'Fork Sight', symbol: 'FSIGHT', pairing: 'usdc', xHandle: 'forksight', website: 'https://example.com',
    description: 'Fork test of the browser launch flow',
    service: { slug: 'fork-sight', name: 'Fork Sight', apiLink: 'http://127.0.0.1:4001/sight/signals?handle=monad', priceUsdc: 500_000n, description: 'Ranked X-style signals (sample data)' },
  });
  const tok = await (await fetch(`${API}/api/tokens/${a.asset}`)).json() as { symbol: string; xHandle: string; service: { slug: string; priceUsdc: string } | null };
  log(`check: /api/tokens/${a.asset} → symbol ${tok.symbol}, x @${tok.xHandle}, service ${tok.service?.slug} @ ${tok.service?.priceUsdc}`);

  await run('MON launch (Chainlink price), no service', { name: 'Fork Feed', symbol: 'FFEED', pairing: 'mon' });

  // Pay a fee without launching (e.g. a failed launch), then the next launch must reuse it.
  log('===== paid receipt survives: pay the fee, verify, no launch');
  const hash = await walletClient.sendTransaction({ to: config.launchFee.treasury, value: BigInt(config.launchFee.wei), gas: 30_000n });
  await publicClient.waitForTransactionReceipt({ hash });
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${API}/api/launch-fee/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txHash: hash }) });
    if (r.status === 201) break;
    await new Promise((res) => setTimeout(res, 2_000));
  }
  log(`status: ${JSON.stringify(await feeStatus(ctx))}`);
  await run('third launch reuses the unused receipt', { name: 'Fork Third', symbol: 'FTHIRD', pairing: 'usdc' });

  log('===== fourth launch in 24h');
  try {
    await planLaunch(ctx, { name: 'Fork Fourth', symbol: 'F4', pairing: 'usdc' });
    log('UNEXPECTED: fourth launch was allowed');
    process.exitCode = 1;
  } catch (e) {
    log(`refused as expected: ${e instanceof LaunchError ? `${e.code}: ${e.message}` : e}`);
  }
} finally {
  mining = false;
}

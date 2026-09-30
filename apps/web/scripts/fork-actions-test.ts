/**
 * Phase D fork test (LOCAL Anvil fork only), same modules as the browser:
 *   --phase 1 : launch (lib/launch) → signed service update (lib/claims.saveService) → agent buys the
 *               token (lib/trade) → agent pays the service over x402 (lib/x402)
 *   (run the keeper once in between: distribute + collect)
 *   --phase 2 : creator collects trading fees, claims escrow, then (after +31 days) releases vesting
 * State (asset, service id) is kept in <STATE_FILE>.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, formatUnits, http, parseUnits, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PERMIT2, UNIVERSAL_ROUTER, V4_QUOTER } from '@astralaunch/shared';
import { executeLaunch, planLaunch, type ChainConfig, type Ctx } from '../src/lib/launch.js';
import { approvePermit2, buildTradeTx, planTrade, sendTrade, simulateTrade, type TradeAddrs } from '../src/lib/trade.js';
import { payAndCall, prepareCall } from '../src/lib/x402.js';
import { prepareCollectFees, prepareEscrowClaim, prepareRelease, saveService } from '../src/lib/claims.js';

const RPC = process.env.ANVIL_RPC ?? 'http://127.0.0.1:8545';
const API = process.env.API ?? 'http://127.0.0.1:3101';
const STATE = process.env.STATE_FILE ?? '/tmp/astralaunch-phase-d.json';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(RPC)) throw new Error('fork only');
const phase = process.argv.includes('2') ? 2 : 1;
const config = await (await fetch(`${API}/api/config`)).json() as ChainConfig;
const chain = defineChain({ id: 143, name: 'fork', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pc = createPublicClient({ chain, transport: http(RPC) });
const creator = privateKeyToAccount(process.env.CREATOR_PRIVATE_KEY as Hex);
const agent = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as Hex);
const wcCreator = createWalletClient({ account: creator, chain, transport: http(RPC) });
const wcAgent = createWalletClient({ account: agent, chain, transport: http(RPC) });
const log = (s: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
const mine = (n: number) => pc.request({ method: 'anvil_mine' as never, params: [`0x${n.toString(16)}`] as never });
let mining = true;
(async () => { while (mining) { await mine(8).catch(() => {}); await new Promise((r) => setTimeout(r, 400)); } })();

try {
  if (phase === 1) {
    const ctx: Ctx = { publicClient: pc as never, walletClient: wcCreator, account: creator.address, apiBase: API, config };
    const slug = `phase-d-${Date.now() % 100000}`;
    const input = { name: 'Phase D', symbol: 'PHD', pairing: 'usdc' as const,
      service: { slug, name: 'Phase D', apiLink: 'http://127.0.0.1:4001/sight/signals?handle=monad', priceUsdc: 500_000n } };
    // a taken slug is refused before any transaction
    try { await planLaunch(ctx, { ...input, service: { ...input.service, slug: 'phase-d' } }); log('UNEXPECTED: taken slug accepted'); }
    catch (e) { log(`taken slug refused before any tx: ${(e as Error).message}`); }
    const plan = await planLaunch(ctx, input);
    const res = await executeLaunch(ctx, input, plan, (s, st, i) => log(`  launch ${s} ${st}${i?.tx ? ` ${i.tx}` : ''}`));
    log(`launched ${res.asset} listed=${res.listed}`);

    const tok = await (await fetch(`${API}/api/tokens/${res.asset}`)).json() as { service: { id: string } };
    await new Promise((r) => setTimeout(r, 1_100)); // signed updates must be newer than the create (replay rule)
    const saved = await saveService(wcCreator, creator.address, API, { existingId: tok.service.id, asset: res.asset, slug, name: 'Phase D',
      priceUsdc: 600_000n });
    log(`service settings saved (signed PATCH): price ${(saved as { priceUsdc: string }).priceUsdc}`);

    const A: TradeAddrs = { universalRouter: UNIVERSAL_ROUTER, permit2: PERMIT2, quoter: V4_QUOTER, vault: config.contracts.vault, wmon: config.tokens.wmon, usdc: config.tokens.usdc };
    // wait out the 12-minute balance cap on the fork, then trade
    await pc.request({ method: 'evm_increaseTime' as never, params: [800] as never }); await mine(1);
    const tp = await planTrade(pc as never, A, agent.address, { side: 'buy', asset: res.asset, amountIn: parseUnits('2', 6) });
    if (tp.needsApproval) await approvePermit2(pc as never, wcAgent, agent.address, A, config.tokens.usdc, tp.amountIn);
    const tx = await buildTradeTx(wcAgent, agent.address, A, 143, tp);
    const gas = await simulateTrade(pc as never, agent.address, tx);
    const sw = await sendTrade(pc as never, wcAgent, agent.address, tx, gas);
    log(`agent bought ${formatUnits(tp.quoteOut, 18)} PHD for 2 USDC · ${sw.hash}`);

    // x402 uses wall-clock validity: sync the fork clock back to now is not possible, so pay before more time travel
    const call = await prepareCall(pc as never, agent.address, `${API}/s/${slug}/sight/signals?handle=phased`, res.asset, config.contracts.registry, config.tokens.usdc);
    if ('free' in call) throw new Error(`expected 402, got ${call.status}`);
    log(`402: ${formatUnits(call.amount, 6)} USDC to router ${call.payTo} (on-chain check ok), balance ${formatUnits(call.balance, 6)}`);
    const paid = await payAndCall(pc as never, wcAgent, agent.address, call);
    log(`paid call → ${paid.status}, settle tx ${paid.settleTx}, body ${paid.body.slice(0, 90)}…`);
    writeFileSync(STATE, JSON.stringify({ asset: res.asset, poolId: res.poolId }));
  } else {
    const st = JSON.parse(readFileSync(STATE, 'utf8')) as { asset: Address; poolId: Hex };
    const bal = (t: Address, who: Address) => pc.readContract({ address: t, abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }], functionName: 'balanceOf', args: [who] });
    const u0 = await bal(config.tokens.usdc, creator.address);
    const fees = await prepareCollectFees(pc as never, wcCreator, creator.address, st.poolId);
    log(`simulated ${fees.label}: ${fees.fn}(${fees.args.join(', ')}) gas ${fees.gas}`);
    log(`sent ${await fees.send()} · creator USDC +${formatUnits((await bal(config.tokens.usdc, creator.address)) - u0, 6)}`);
    const u1 = await bal(config.tokens.usdc, creator.address);
    const esc = await prepareEscrowClaim(pc as never, wcCreator, creator.address, config.contracts.escrow, st.asset);
    log(`simulated ${esc.label}: ${esc.fn}(${esc.args.join(', ')}) gas ${esc.gas}`);
    log(`sent ${await esc.send()} · creator USDC +${formatUnits((await bal(config.tokens.usdc, creator.address)) - u1, 6)}`);
    try { await prepareRelease(pc as never, wcCreator, creator.address, st.asset); log('UNEXPECTED: release allowed before the cliff'); }
    catch (e) { log(`release before cliff refused: ${(e as Error).message}`); }
    await pc.request({ method: 'evm_increaseTime' as never, params: [31 * 86_400] as never }); await mine(1);
    const t0 = await bal(st.asset, creator.address);
    const rel = await prepareRelease(pc as never, wcCreator, creator.address, st.asset);
    log(`simulated ${rel.label}: ${rel.fn}(${rel.args.join(', ')}) gas ${rel.gas}`);
    log(`sent ${await rel.send()} · creator PHD +${formatUnits((await bal(st.asset, creator.address)) - t0, 18)}`);
  }
} finally { mining = false; }

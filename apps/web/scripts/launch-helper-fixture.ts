/**
 * Writes SDK-encoded Airlock CreateParams (USDC and MON pairings) for the LaunchHelper Foundry fork
 * test, using the same code path as the browser (src/lib/launch.ts). Local Anvil fork ONLY.
 *
 *   ANVIL_RPC=http://127.0.0.1:8546 pnpm exec tsx scripts/launch-helper-fixture.ts
 *   → astralaunch-anvil/.anvil-state/launch-helper-fixture.json (read by test/fork/LaunchHelperFork.t.sol)
 */
import { writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, encodeAbiParameters, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  AIRLOCK, LAUNCH_FEE_MON, LAUNCH_FEE_TREASURY, LAUNCH_FEE_WEI, LAUNCH_RATE_LIMIT, MON_USD_ORACLE, USDC, WMON,
} from '@astralaunch/shared';
import deployment from '../../../packages/contracts/deployments/monad-mainnet.json' with { type: 'json' };
import { launchCreateParams, launchHelperAbi, type ChainConfig, type Ctx } from '../src/lib/launch.js';

const RPC = process.env.ANVIL_RPC ?? 'http://127.0.0.1:8546';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(RPC)) throw new Error(`Refusing non-local RPC ${RPC}: fork only.`);
const OUT = new URL('../../../astralaunch-anvil/.anvil-state/launch-helper-fixture.json', import.meta.url);

// Anvil #0: fork-only test key, never used on mainnet.
const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const chain = defineChain({ id: 143, name: 'Monad fork', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const config: ChainConfig = {
  chainId: 143,
  contracts: { registry: deployment.registry as Hex, escrow: deployment.escrow as Hex, vault: deployment.vault as Hex, platformFeeReceiver: deployment.platformFeeReceiver as Hex },
  tokens: { usdc: USDC as Hex, wmon: WMON as Hex }, monUsdOracle: MON_USD_ORACLE as Hex,
  launchFee: { mon: LAUNCH_FEE_MON, wei: LAUNCH_FEE_WEI.toString(), treasury: LAUNCH_FEE_TREASURY as Hex, maxPer24h: LAUNCH_RATE_LIMIT },
};
const ctx: Ctx = { publicClient: publicClient as never, walletClient: createWalletClient({ account, chain, transport: http(RPC) }), account: account.address, apiBase: '', config };

const tupleType = launchHelperAbi[0].inputs[0];
const block = await publicClient.getBlock();
const startTime = Number(block.timestamp) + 60;
const out: Record<string, unknown> = { block: Number(block.number), blockTimestamp: Number(block.timestamp), startTime, airlock: AIRLOCK };
for (const pairing of ['usdc', 'mon'] as const) {
  const r = await launchCreateParams(ctx, { name: `Helper ${pairing.toUpperCase()}`, symbol: `H${pairing.toUpperCase()}`, pairing }, startTime);
  out[pairing] = { creator: r.creator, numeraire: r.numeraire, createParams: encodeAbiParameters([tupleType], [r.createParams]) };
}
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`fixture at block ${out.block} (ts ${out.blockTimestamp}, startTime ${startTime}) → ${OUT.pathname}`);

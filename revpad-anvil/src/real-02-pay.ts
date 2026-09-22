// real-02-pay.ts — One real x402 payment of 0.02 USDC on Monad mainnet.
// Requires .env.real with REAL_PRIVATE_KEY (must NOT be an Anvil dev account).
// HARD CAP: 0.02 USDC. Will NOT settle without explicit "yes" typed at the prompt.
// Primary facilitator: https://x402-facilitator.molandak.org  (Monad official, docs.monad.xyz)
// Override via REAL_FAC env var to test a different facilitator.
// After settlement the script also probes https://x402.org/facilitator/supported and notes
// whether eip155:143 is listed (prints REAL_FAC command for an optional second run).
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.real' });

import { HTTPFacilitatorClient } from '@x402/core/http';
import { x402Client } from '@x402/core/client';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { toClientEvmSigner } from '@x402/evm';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { createInterface } from 'node:readline';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  http,
  parseUnits,
  publicActions,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ---- Anvil dev account addresses (mnemonic indices 0–9) — refuse if key matches ----
const ANVIL_DEV = new Set([
  '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
  '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
  '0x90f79bf6eb2c4f870365e785982e1f101e93b906',
  '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65',
  '0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc',
  '0x976ea74026e726554db657fa54763abd0c3a0aa9',
  '0x14dc79964da2c08b23698b3d3cc7ca32193d9955',
  '0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f',
  '0xa0ee7a142d267c1f36714e4a8f75612f20a79720',
]);

// ---- Constants ----
const CHAIN_ID = 143;
const NETWORK = 'eip155:143' as const;
const MONAD_RPC = process.env.REAL_RPC_URL ?? 'https://rpc.monad.xyz';
const USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603' as Address;
// Hard cap: 0.02 USDC — NOT overridable via env or argv.
const PRICE = parseUnits('0.02', 6); // 20_000 units
const SAFETY_CAP = parseUnits('0.05', 6);
if (PRICE > SAFETY_CAP) throw new Error('BUG: PRICE exceeds safety cap of 0.05 USDC');
// Monad official facilitator (docs.monad.xyz, agentic payments). Supports x402 v2 only.
const FAC = process.env.REAL_FAC ?? 'https://x402-facilitator.molandak.org';
// Probed after settlement to check optional second-run support (no payment sent).
const X402_ORG_FAC = 'https://x402.org/facilitator';

const erc20Abi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view',  inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'name',      stateMutability: 'view',  inputs: [],                               outputs: [{ type: 'string'  }] },
] as const;

const eip3009Abi = [
  { type: 'function', name: 'version', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const;

function pass(ok: boolean, label: string, detail = ''): boolean {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) process.exitCode = 1;
  return ok;
}

function redactSig(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redactSig);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    out[k] = (k === 'signature' || k === 'authorization') ? '<redacted>' : redactSig(v);
  }
  return out;
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

async function main() {
  // ---- Key validation ----
  const rawKey = process.env.REAL_PRIVATE_KEY;
  if (!rawKey) throw new Error('REAL_PRIVATE_KEY not set in .env.real. Copy .env.real.example and fill it in.');
  const key = (rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as `0x${string}`;
  const acct = privateKeyToAccount(key);

  if (ANVIL_DEV.has(acct.address.toLowerCase())) {
    throw new Error(
      `REAL_PRIVATE_KEY resolves to ${acct.address}, which is an Anvil dev account.\n` +
      'Set a real private key in .env.real that you control on Monad mainnet.',
    );
  }

  // payTo: from env or default to sender (self-payment is valid for testing)
  const payTo = (process.env.REAL_PAYTO ?? acct.address) as Address;

  // ---- Clients ----
  const monadChain = defineChain({
    id: CHAIN_ID,
    name: 'Monad Mainnet',
    nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [MONAD_RPC] } },
    contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
  });

  const publicClient = createPublicClient({ chain: monadChain, transport: http(MONAD_RPC) });
  const walletClient = createWalletClient({ account: acct, chain: monadChain, transport: http(MONAD_RPC) })
    .extend(publicActions);

  const chainId = await publicClient.getChainId();
  if (chainId !== CHAIN_ID) throw new Error(`RPC chainId=${chainId}, expected ${CHAIN_ID} (Monad mainnet). Check REAL_RPC_URL.`);

  const block = await publicClient.getBlock();
  console.log(`Monad OK: block ${block.number}  ${new Date(Number(block.timestamp) * 1000).toISOString()}`);
  console.log(`Facilitator: ${FAC}\n`);

  // ---- USDC metadata (read on-chain — do NOT hardcode name) ----
  const usdcName = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'name' });
  let usdcVersion = '2'; // confirmed in VERIFICATION-anvil.md; read live to catch drift
  try {
    usdcVersion = await publicClient.readContract({ address: USDC, abi: eip3009Abi, functionName: 'version' });
  } catch { /* use default */ }
  console.log(`USDC name()="${usdcName}"  version()="${usdcVersion}"`);

  // ---- Balance check ----
  const senderBal = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [acct.address] });
  const monBal    = await publicClient.getBalance({ address: acct.address });
  console.log(`Sender ${acct.address}`);
  console.log(`  USDC: ${formatUnits(senderBal, 6)}  MON: ${formatUnits(monBal, 18)}`);
  if (senderBal < PRICE) {
    throw new Error(
      `Insufficient USDC: wallet has ${formatUnits(senderBal, 6)}, need ${formatUnits(PRICE, 6)}.\n` +
      'Fund the wallet and retry.',
    );
  }

  // ---- Facilitator /supported ----
  console.log(`\nGET ${FAC}/supported ...`);
  const facClient = new HTTPFacilitatorClient({ url: FAC });
  const supported = await facClient.getSupported();
  console.log('Full /supported response:');
  console.log(JSON.stringify(supported, null, 2));

  // Find the eip155:143 exact entry; note x402Version because molandak.org supports v2 only.
  const monadKind = supported.kinds.find(
    (k) => k.network === NETWORK && k.scheme === 'exact',
  );
  pass(!!monadKind, `facilitator lists exact on ${NETWORK}`,
    monadKind ? `x402Version=${monadKind.x402Version}` : 'NOT FOUND');
  if (!monadKind) {
    console.error('Aborting: facilitator does not support Monad mainnet exact payments.');
    process.exit(1);
  }

  // ---- Build payment payload (EIP-3009 sign — no tx) ----
  const requirements: PaymentRequirements = {
    scheme: 'exact',
    network: NETWORK,
    asset: USDC,
    amount: PRICE.toString(),
    payTo,
    maxTimeoutSeconds: 60,
    extra: { name: usdcName, version: usdcVersion },
  };

  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    resource: {
      url: 'https://revpad.xyz/s/demo/real',
      description: 'Revpad real payment test (VERIFICATION-real.md)',
      mimeType: 'application/json',
    },
    accepts: [requirements],
  };

  console.log('\nSigning payment payload (EIP-3009, no tx)...');
  const xClient = new x402Client();
  registerExactEvmScheme(xClient, {
    signer: toClientEvmSigner(acct, publicClient as any),
    networks: [NETWORK],
  });
  const payload = await xClient.createPaymentPayload(paymentRequired);

  // paymentRequirements for verify/settle MUST be payload.accepted (what was actually selected)
  const acceptedReqs = payload.accepted;

  // Debug: print the wire body with signature redacted so we can see what is sent
  const wireBody = {
    x402Version: payload.x402Version,
    paymentPayload: redactSig(payload),
    paymentRequirements: acceptedReqs,
  };
  console.log('\nWire body (signature redacted):');
  console.log(JSON.stringify(wireBody, null, 2));

  // ---- Verify (before confirmation prompt) ----
  console.log('\nPOST /verify ...');
  let verifyResult: Awaited<ReturnType<typeof facClient.verify>>;
  try {
    verifyResult = await facClient.verify(payload, acceptedReqs);
  } catch (e: any) {
    console.error('HTTPFacilitatorClient.verify threw:', e?.message ?? e);
    throw e;
  }
  console.log('Verify response:', JSON.stringify(verifyResult, null, 2));
  pass(verifyResult.isValid === true, 'facilitator /verify', verifyResult.invalidReason ?? '');
  if (!verifyResult.isValid) {
    throw new Error(`/verify failed: ${verifyResult.invalidReason}. Aborting before settle.`);
  }

  // ---- Confirmation prompt (AFTER verify passes) ----
  console.log('\n========================================================');
  console.log('  VERIFY PASSED — review before typing "yes" to settle');
  console.log('========================================================');
  console.log(`  Sender (payer):     ${acct.address}`);
  console.log(`  Sender USDC bal:    ${formatUnits(senderBal, 6)} USDC`);
  console.log(`  PayTo (recipient):  ${payTo}`);
  console.log(`  Amount:             ${formatUnits(PRICE, 6)} USDC (hard cap ${formatUnits(SAFETY_CAP, 6)} USDC)`);
  console.log(`  Asset:              ${USDC}  (name="${usdcName}" version="${usdcVersion}")`);
  console.log(`  Network:            ${NETWORK}`);
  console.log(`  Facilitator:        ${FAC}`);
  console.log(`  Verify payer:       ${verifyResult.payer ?? '(not returned)'}`);
  console.log('========================================================\n');

  const answer = await prompt('Type "yes" to settle, anything else to abort: ');
  if (answer.toLowerCase() !== 'yes') {
    throw new Error(`Aborted by user (got "${answer}"). Verify PASSED but no settlement was submitted.`);
  }

  // ---- Settle ----
  console.log('\nPOST /settle ...');
  const beforeBal = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [payTo] });
  let settleResult: Awaited<ReturnType<typeof facClient.settle>>;
  try {
    settleResult = await facClient.settle(payload, acceptedReqs);
  } catch (e: any) {
    console.error('HTTPFacilitatorClient.settle threw:', e?.message ?? e);
    throw e;
  }
  console.log('Settle response:', JSON.stringify(settleResult, null, 2));
  pass(settleResult.success === true, 'facilitator /settle',
    settleResult.transaction ?? (settleResult as any).errorReason ?? '');

  if (!settleResult.success) {
    throw new Error(`/settle failed: ${(settleResult as any).errorReason}`);
  }

  console.log(`  tx: ${settleResult.transaction}`);

  // ---- Wait for receipt ----
  console.log('\nWaiting for transaction receipt on Monad...');
  const receipt = await publicClient.waitForTransactionReceipt({ hash: settleResult.transaction as `0x${string}` });
  pass(receipt.status === 'success', 'settlement tx status', receipt.status);
  console.log(`  block: ${receipt.blockNumber}  gasUsed: ${receipt.gasUsed}  from: ${receipt.from}`);

  // ---- Balance delta ----
  const afterBal = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [payTo] });
  if (payTo.toLowerCase() === acct.address.toLowerCase()) {
    // Self-payment: USDC leaves sender and re-enters the same account; net delta is always 0.
    // The on-chain receipt status (already checked) is the authoritative confirmation.
    pass(receipt.status === 'success', 'self-payment confirmed via receipt (payTo=sender; balance delta=0 expected)', receipt.status);
  } else {
    pass(afterBal - beforeBal === PRICE, `payTo received ${formatUnits(PRICE, 6)} USDC`,
      `delta=${formatUnits(afterBal - beforeBal, 6)}`);
  }

  // ---- Replay rejection ----
  console.log('\nTesting replay rejection (POST /settle with same payload)...');
  let replay: Awaited<ReturnType<typeof facClient.settle>>;
  try {
    replay = await facClient.settle(payload, acceptedReqs);
    pass(replay.success !== true, 'replay rejected', (replay as any).errorReason ?? String(replay.success));
  } catch (e: any) {
    // Some facilitators return 4xx on replay — that also counts as rejection.
    pass(true, 'replay rejected (facilitator threw on duplicate)', e?.message ?? String(e));
  }

  // ---- Summary ----
  console.log('\n========================================================');
  console.log('  SUMMARY');
  console.log('========================================================');
  console.log(`  Settlement tx:      ${settleResult.transaction}`);
  console.log(`  tx.from (submitter):${receipt.from}`);
  console.log(`  Block:              ${receipt.blockNumber}`);
  console.log(`  Gas used:           ${receipt.gasUsed}`);
  console.log(`  Amount paid:        ${formatUnits(PRICE, 6)} USDC`);
  console.log(`  PayTo balance Δ:    +${formatUnits(afterBal - beforeBal, 6)} USDC`);
  console.log('========================================================');

  // ---- Optional: probe x402.org/facilitator for Monad support (no payment sent) ----
  if (FAC !== X402_ORG_FAC) {
    console.log(`\nProbing ${X402_ORG_FAC}/supported for eip155:143 (informational — no payment)...`);
    try {
      const x402OrgClient = new HTTPFacilitatorClient({ url: X402_ORG_FAC });
      const x402Supported = await x402OrgClient.getSupported();
      const x402MonadKind = x402Supported.kinds.find(
        (k) => k.network === NETWORK && k.scheme === 'exact',
      );
      if (x402MonadKind) {
        console.log(`  FOUND: ${JSON.stringify(x402MonadKind)}`);
        console.log(`  Optional second run: REAL_FAC=${X402_ORG_FAC} npm run pay-real`);
      } else {
        console.log(`  NOT FOUND — eip155:143 not listed by x402.org`);
        console.log('  Networks listed:', x402Supported.kinds.map(k => k.network + '/' + k.scheme).join(', '));
      }
    } catch (e: any) {
      console.warn(`  probe failed: ${e?.message ?? e}`);
    }
  }

  console.log('\nPart 2 complete.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

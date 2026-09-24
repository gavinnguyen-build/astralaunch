// Mainnet paid call — one x402 payment through the Revpad gateway.
//
//   read -s AGENT_PRIVATE_KEY && export AGENT_PRIVATE_KEY
//   SERVER_URL=http://localhost:3001 \
//   SERVICE_SLUG=nullsight \
//   SERVICE_PATH=/json \
//   MONAD_RPC_URL=https://rpc.monad.xyz \
//     npx tsx src/mainnet-pay.ts
//
// Prints: 402 requirements, response body, settlement tx hash, router USDC before/after.

import { x402Client } from '@x402/core/client';
import type { PaymentRequired } from '@x402/core/types';
import { toClientEvmSigner } from '@x402/evm';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { encodePaymentSignatureHeader } from '@x402/core/http';
import {
  createPublicClient,
  defineChain,
  formatUnits,
  getAddress,
  http,
  parseAbiItem,
  type Address,
} from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';

const CHAIN_ID = 143;
const NETWORK = 'eip155:143' as const;
const USDC: Address = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';

const erc20Abi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';
const ANVIL_ADDRESSES = new Set(
  Array.from({ length: 10 }, (_, i) =>
    getAddress(mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: i }).address)
  )
);

function need(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env var: ${key}`);
  return v;
}

async function main() {
  // ── 1. Setup ─────────────────────────────────────────────────────────────────
  const privateKey = need('AGENT_PRIVATE_KEY') as `0x${string}`;
  const account = privateKeyToAccount(privateKey);
  const rpcUrl = need('MONAD_RPC_URL');
  const serverUrl = need('SERVER_URL');
  const slug = need('SERVICE_SLUG');
  const path = process.env.SERVICE_PATH ?? '/json';

  const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(rpcUrl);
  if (!isLocalhost && ANVIL_ADDRESSES.has(getAddress(account.address))) {
    throw new Error(`Refusing Anvil dev account ${account.address} on non-localhost RPC.`);
  }

  const monad = defineChain({
    id: CHAIN_ID,
    name: 'Monad',
    nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
  });
  const publicClient = createPublicClient({ chain: monad, transport: http(rpcUrl) });

  // Check agent USDC balance
  const agentBal = await publicClient.readContract({
    address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [account.address],
  });
  console.log(`Agent: ${account.address}  USDC: ${formatUnits(agentBal, 6)}`);

  // ── 2. Get service manifest ──────────────────────────────────────────────────
  console.log(`\nGET ${serverUrl}/api/services/${slug}/manifest`);
  const manifestRes = await fetch(`${serverUrl}/api/services/${slug}/manifest`);
  if (!manifestRes.ok) throw new Error(`Manifest fetch failed: ${manifestRes.status} ${await manifestRes.text()}`);
  const manifest = await manifestRes.json() as any;
  const requirements = manifest.payment;
  const router = requirements.payTo as Address;

  console.log('\nPayment requirements:');
  console.log(JSON.stringify(requirements, null, 2));
  console.log(`\nPrice: ${formatUnits(BigInt(requirements.amount), 6)} USDC`);
  console.log(`PayTo (router): ${router}`);

  if (agentBal < BigInt(requirements.amount)) {
    throw new Error(`Insufficient USDC: have ${formatUnits(agentBal, 6)}, need ${formatUnits(BigInt(requirements.amount), 6)}`);
  }

  // ── 3. Record router balance before ──────────────────────────────────────────
  const beforeBlock = await publicClient.getBlockNumber();
  const routerBefore = await publicClient.readContract({
    address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [router],
  });
  console.log(`\nRouter USDC before: ${formatUnits(routerBefore, 6)}`);

  // ── 4. Sign payment ──────────────────────────────────────────────────────────
  const gatewayUrl = `${serverUrl}/s/${slug}${path}`;
  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    resource: { url: gatewayUrl, description: manifest.name ?? slug, mimeType: 'application/json' },
    accepts: [requirements],
  };

  console.log('\nSigning payment (EIP-3009)...');
  const client = new x402Client();
  registerExactEvmScheme(client, {
    signer: toClientEvmSigner(account, publicClient as any),
    networks: [NETWORK],
  });
  const payload = await client.createPaymentPayload(paymentRequired);
  const payHeader = encodePaymentSignatureHeader(payload);

  // ── 5. Make paid request ─────────────────────────────────────────────────────
  console.log(`\nGET ${gatewayUrl} (with X-PAYMENT)`);
  const paidRes = await fetch(gatewayUrl, { headers: { 'X-PAYMENT': payHeader } });
  const paidBody = paidRes.headers.get('content-type')?.includes('json')
    ? await paidRes.json()
    : await paidRes.text();

  console.log(`Status: ${paidRes.status}`);
  if (paidRes.status === 200) {
    console.log('Response:', JSON.stringify(paidBody, null, 2).slice(0, 500));
  } else {
    console.error('Unexpected status:', paidRes.status, paidBody);
    process.exit(1);
  }

  // ── 6. Check router balance after + find settlement tx ───────────────────────
  // Wait a moment for the settlement tx to land
  console.log('\nWaiting for settlement to land...');
  await new Promise((r) => setTimeout(r, 3000));

  const routerAfter = await publicClient.readContract({
    address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [router],
  });
  const delta = routerAfter - routerBefore;
  console.log(`Router USDC after:  ${formatUnits(routerAfter, 6)}`);
  console.log(`Router USDC delta:  +${formatUnits(delta, 6)}`);

  const expectedDelta = BigInt(requirements.amount);
  if (delta === expectedDelta) {
    console.log(`PASS  Router received exactly ${formatUnits(expectedDelta, 6)} USDC`);
  } else {
    console.log(`WARN  Expected +${formatUnits(expectedDelta, 6)}, got +${formatUnits(delta, 6)}`);
  }

  // Find the USDC Transfer event to the router to get the settle tx hash
  const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
  const logs = await publicClient.getLogs({
    address: USDC,
    event: transferEvent,
    args: { to: router },
    fromBlock: beforeBlock,
    toBlock: 'latest',
  });

  if (logs.length > 0) {
    const settleTx = logs[logs.length - 1].transactionHash;
    console.log(`\nSettlement tx: ${settleTx}`);

    const receipt = await publicClient.getTransactionReceipt({ hash: settleTx });
    console.log(`  from:    ${receipt.from}`);
    console.log(`  block:   ${receipt.blockNumber}`);
    console.log(`  gasUsed: ${receipt.gasUsed}`);
  } else {
    console.log('\nWARN: No USDC Transfer event found to router. Settlement may still be pending.');
  }

  // Agent balance after
  const agentAfter = await publicClient.readContract({
    address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [account.address],
  });
  console.log(`\nAgent USDC after: ${formatUnits(agentAfter, 6)} (spent ${formatUnits(agentBal - agentAfter, 6)})`);

  console.log('\n=== PAID CALL COMPLETE ===');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

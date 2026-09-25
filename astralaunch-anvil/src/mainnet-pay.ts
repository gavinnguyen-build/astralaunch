// One paid x402 call through the Astralaunch gateway (v2).
//
//   read -s AGENT_PRIVATE_KEY && export AGENT_PRIVATE_KEY
//   SLUG=nullsight SERVICE_PATH=/json SERVER_URL=http://localhost:3001 \
//     npx tsx src/mainnet-pay.ts [--yes]
//
// Env:
//   AGENT_PRIVATE_KEY   required (payer; needs USDC, no MON needed: EIP-3009 is gasless for the payer)
//   SLUG                required (SERVICE_SLUG also accepted)
//   SERVICE_PATH        default /  (named SERVICE_PATH, not PATH, so the shell's PATH is not clobbered)
//   SERVER_URL          default http://localhost:3001
//   MONAD_RPC_URL       default https://rpc.monad.xyz (balance, on-chain router check, settlement lookup)
//   CONTRACTS_JSON_PATH default ../packages/contracts/deployments/monad-mainnet.json (AstralaunchRegistry)
//   ALLOW_ANVIL_KEYS=1  local fork only
//
// Flow: GET gateway → 402 → check requirements (exact, Monad, USDC, payTo == registry.routers(asset))
// → check USDC balance → confirm → sign EIP-3009 for exactly `amount` → retry → print status,
// body and the settlement tx (PAYMENT-RESPONSE header, else the USDC Transfer log).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { toClientEvmSigner } from '@x402/evm';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import {
  createPublicClient, defineChain, formatUnits, getAddress, http, parseAbiItem, type Address,
} from 'viem';
import { MONAD_CHAIN_ID, MONAD_NETWORK, USDC } from '../../packages/shared/src/index.js';
import { accountFromEnv, confirm, need, readBody, run, show } from './mainnet-cli.js';

const erc20Abi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;
const registryAbi = [
  { type: 'function', name: 'routers', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'address' }] },
] as const;
const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

run(async () => {
  const server = (process.env.SERVER_URL ?? 'http://localhost:3001').replace(/\/$/, '');
  const slug = process.env.SLUG ?? need('SERVICE_SLUG');
  const path = process.env.SERVICE_PATH ?? '/';
  const rpcUrl = process.env.MONAD_RPC_URL ?? 'https://rpc.monad.xyz';
  const contractsPath = process.env.CONTRACTS_JSON_PATH ?? fileURLToPath(new URL('../../packages/contracts/deployments/monad-mainnet.json', import.meta.url));
  if (!existsSync(contractsPath)) throw new Error(`Not found: ${contractsPath}`);
  const registry = getAddress(JSON.parse(readFileSync(contractsPath, 'utf8')).registry);
  const account = accountFromEnv('AGENT_PRIVATE_KEY');

  const monad = defineChain({
    id: MONAD_CHAIN_ID, name: 'Monad',
    nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain: monad, transport: http(rpcUrl) });
  const chainId = await publicClient.getChainId();
  if (chainId !== MONAD_CHAIN_ID) throw new Error(`RPC chain id ${chainId}, expected ${MONAD_CHAIN_ID}`);

  const gatewayUrl = `${server}/s/${slug}${path.startsWith('/') ? path : `/${path}`}`;
  console.log(`Agent:    ${account.address}`);
  console.log(`Gateway:  ${gatewayUrl}`);
  console.log(`RPC:      ${rpcUrl}`);

  // ── 1. Service → token asset ──
  const manRes = await fetch(`${server}/api/services/${encodeURIComponent(slug)}/manifest`);
  if (!manRes.ok) throw new Error(`Manifest ${slug} → ${manRes.status}: ${JSON.stringify(await readBody(manRes))}`);
  const manifest = await manRes.json() as { asset?: string; name?: string };
  if (!manifest.asset) throw new Error('Manifest has no asset field; update the server first.');
  const asset = getAddress(manifest.asset);

  // ── 2. Unpaid request → 402 ──
  const http402 = new x402HTTPClient(new x402Client());
  const first = await fetch(gatewayUrl);
  if (first.status !== 402) {
    show(`Expected 402, got ${first.status}`, await readBody(first));
    throw new Error('Gateway did not ask for payment; nothing was paid.');
  }
  const paymentRequired: PaymentRequired = http402.getPaymentRequiredResponse(
    (n) => first.headers.get(n), await readBody(first),
  );

  // ── 3. Check requirements against chain ──
  const router = getAddress(await publicClient.readContract({ address: registry, abi: registryAbi, functionName: 'routers', args: [asset] }));
  const req = paymentRequired.accepts.find((r: PaymentRequirements) =>
    r.scheme === 'exact' && r.network === MONAD_NETWORK && getAddress(r.asset) === getAddress(USDC));
  if (!req) throw new Error(`No "exact" USDC requirement on ${MONAD_NETWORK} in the 402: ${JSON.stringify(paymentRequired.accepts)}`);
  if (router === '0x0000000000000000000000000000000000000000') throw new Error(`Token ${asset} is not registered in AstralaunchRegistry ${registry}`);
  if (getAddress(req.payTo) !== router) {
    throw new Error(`payTo ${req.payTo} is NOT the token's router ${router} (registry.routers(${asset})). Refusing to pay.`);
  }
  const amount = BigInt(req.amount);

  const balance = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
  console.log(`Agent USDC balance: ${formatUnits(balance, 6)}`);
  if (balance < amount) {
    throw new Error(`Insufficient USDC: have ${formatUnits(balance, 6)}, need ${formatUnits(amount, 6)}. Nothing was signed.`);
  }

  show('Payment to sign (EIP-3009 transferWithAuthorization)', {
    from: account.address, to: router, asset: USDC, amountUsdc: formatUnits(amount, 6), amountRaw: amount,
    network: req.network, maxTimeoutSeconds: req.maxTimeoutSeconds, token: asset, service: manifest.name ?? slug,
  });
  await confirm(`Pay ${formatUnits(amount, 6)} USDC to router ${router} for ${gatewayUrl}?`);

  // ── 4. Sign for exactly this requirement ──
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: toClientEvmSigner(account, publicClient as any), networks: [MONAD_NETWORK] });
  const payload = await client.createPaymentPayload({ ...paymentRequired, accepts: [req] });
  const auth = (payload.payload as { authorization?: { to: string; value: string; from: string } }).authorization;
  if (!auth || getAddress(auth.to) !== router || BigInt(auth.value) !== amount || getAddress(auth.from) !== getAddress(account.address)) {
    throw new Error('Signed authorization does not match the requirement (to/value/from). Not sending.');
  }

  // ── 5. Paid retry ──
  const fromBlock = await publicClient.getBlockNumber();
  const paid = await fetch(gatewayUrl, { headers: http402.encodePaymentSignatureHeader(payload) });
  const body = await readBody(paid);
  console.log(`\nStatus: ${paid.status}`);
  const bodyText = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  console.log(`Response body${bodyText.length > 4000 ? ' (first 4000 chars)' : ''}:\n${bodyText.slice(0, 4000)}`);

  // ── 6. Settlement tx ──
  let settleTx: `0x${string}` | undefined;
  try {
    const settle = http402.getPaymentSettleResponse((n) => paid.headers.get(n));
    settleTx = settle.transaction as `0x${string}`;
  } catch { /* header absent: fall back to the Transfer log */ }
  if (!settleTx && paid.ok) {
    for (let i = 0; i < 10 && !settleTx; i++) {
      const logs = await publicClient.getLogs({
        address: USDC, event: transferEvent, args: { from: account.address, to: router }, fromBlock, toBlock: 'latest',
      });
      settleTx = logs.find((l) => l.args.value === amount)?.transactionHash;
      if (!settleTx) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (settleTx) {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: settleTx, timeout: 30_000 });
    console.log(`\nSettlement tx: ${settleTx}  (status ${receipt.status}, block ${receipt.blockNumber}, from ${receipt.from})`);
  } else {
    console.log('\nNo settlement tx found' + (paid.ok ? ' yet; check the router\'s USDC transfers.' : ' (the call was not charged).'));
  }
  const after = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
  console.log(`Agent USDC after: ${formatUnits(after, 6)} (spent ${formatUnits(balance - after, 6)})`);
  if (!paid.ok) throw new Error(`Paid request returned ${paid.status}`);
});

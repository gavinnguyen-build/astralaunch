// Test 07 — x402 exact payment on the fork: agent signs EIP-3009, local facilitator verifies + settles to payTo.
// Requires: npm run facilitator (in another terminal / VS Code task). Run before any time travel:
// EIP-3009 validity uses wall-clock time, a fork warped into the future makes authorizations look expired.
import { x402Client } from '@x402/core/client';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { toClientEvmSigner } from '@x402/evm';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { formatUnits, parseUnits } from 'viem';
import { NETWORK, USDC, account, assertFork, balanceOf, erc20Abi, pass, publicClient } from './env.js';

const FAC = `http://127.0.0.1:${process.env.FACILITATOR_PORT ?? 4020}`;

async function post(path: string, body: unknown) {
  const r = await fetch(`${FAC}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json() as Promise<any>;
}

async function main() {
  await assertFork();
  const agent = account('agent');
  const payTo = account('routerStub').address;
  const price = parseUnits(process.argv[2] ?? '0.02', 6);

  const usdcName = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'name' });
  const requirements: PaymentRequirements = {
    scheme: 'exact',
    network: NETWORK,
    asset: USDC,
    amount: price.toString(),
    payTo,
    maxTimeoutSeconds: 60,
    extra: { name: usdcName, version: process.env.USDC_EIP712_VERSION ?? '2' },
  };
  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    resource: { url: 'http://127.0.0.1/s/demo/signals', description: 'Astralaunch demo service', mimeType: 'application/json' },
    accepts: [requirements],
  };

  const client = new x402Client();
  registerExactEvmScheme(client, { signer: toClientEvmSigner(agent, publicClient as any), networks: [NETWORK] });
  const payload = await client.createPaymentPayload(paymentRequired);

  const before = await balanceOf(USDC, payTo);
  const v = await post('/verify', { paymentPayload: payload, paymentRequirements: requirements });
  pass(v.isValid === true, 'facilitator verify', v.invalidReason ?? '');

  const s = await post('/settle', { paymentPayload: payload, paymentRequirements: requirements });
  pass(s.success === true, 'facilitator settle', s.transaction ?? s.errorReason ?? '');
  const after = await balanceOf(USDC, payTo);
  pass(after - before === price, `payTo received ${formatUnits(price, 6)} USDC`, formatUnits(after - before, 6));

  if (s.transaction) {
    const tx = await publicClient.getTransaction({ hash: s.transaction });
    pass(tx.from.toLowerCase() === account('facilitator').address.toLowerCase(), 'settlement tx submitted by the facilitator (clean-revenue signal)', tx.from);
  }

  const replay = await post('/settle', { paymentPayload: payload, paymentRequirements: requirements });
  pass(replay.success !== true, 'replaying the same payment is rejected', replay.errorReason ?? '');

  const tampered = { ...requirements, amount: (price * 2n).toString() };
  const vt = await post('/verify', { paymentPayload: payload, paymentRequirements: tampered });
  pass(vt.isValid !== true, 'payment does not verify against a different amount', vt.invalidReason ?? '');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

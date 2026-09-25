/**
 * "Try API": pay a service over x402 from the browser wallet (EIP-3009, signed, no gas for the payer).
 * Flow: request → 402 (parsed by the SDK's x402HTTPClient, standard v2 headers) → checks against chain
 * (exact scheme, Monad, USDC, payTo == AstralaunchRegistry.routers(asset), balance) → confirmation →
 * sign the authorization for exactly the required amount → retry → response body + settlement tx.
 * The gateway only settles after the upstream answered 2xx (never charged on failure).
 */
import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { toClientEvmSigner } from '@x402/evm';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { getAddress, type Address, type PublicClient, type WalletClient } from 'viem';
import { MONAD_NETWORK } from '@astralaunch/shared';

const registryAbi = [{ type: 'function', name: 'routers', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'address' }] }] as const;
const erc20Abi = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }] as const;

export interface CallPlan {
  url: string; paymentRequired: PaymentRequired; requirement: PaymentRequirements;
  amount: bigint; payTo: Address; balance: bigint;
}

export async function prepareCall(pc: PublicClient, account: Address, url: string, asset: Address, registry: Address, usdc: Address): Promise<CallPlan | { free: true; status: number; body: string }> {
  const first = await fetch(url);
  if (first.status !== 402) return { free: true, status: first.status, body: await first.text() };
  const http = new x402HTTPClient(new x402Client());
  const paymentRequired = http.getPaymentRequiredResponse((n) => first.headers.get(n), await first.json().catch(() => undefined));
  const req = paymentRequired.accepts.find((r) => r.scheme === 'exact' && r.network === MONAD_NETWORK && getAddress(r.asset) === getAddress(usdc));
  if (!req) throw new Error('The service did not offer an exact USDC payment on Monad.');
  const router = getAddress(await pc.readContract({ address: registry, abi: registryAbi, functionName: 'routers', args: [asset] }));
  if (getAddress(req.payTo) !== router) throw new Error(`payTo ${req.payTo} is not this token's revenue router ${router}. Not paying.`);
  const balance = await pc.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [account] });
  return { url, paymentRequired, requirement: req, amount: BigInt(req.amount), payTo: router, balance };
}

export async function payAndCall(pc: PublicClient, wc: WalletClient, account: Address, plan: CallPlan) {
  if (plan.balance < plan.amount) throw new Error('Not enough USDC in this wallet for one call.');
  const client = new x402Client();
  const signer = toClientEvmSigner({
    address: account,
    signTypedData: (m) => wc.signTypedData({ account, domain: m.domain, types: m.types, primaryType: m.primaryType, message: m.message } as never),
  }, pc as never);
  registerExactEvmScheme(client, { signer, networks: [MONAD_NETWORK] });
  const payload = await client.createPaymentPayload({ ...plan.paymentRequired, accepts: [plan.requirement] });
  const auth = (payload.payload as { authorization?: { to: string; value: string; from: string } }).authorization;
  if (!auth || getAddress(auth.to) !== plan.payTo || BigInt(auth.value) !== plan.amount || getAddress(auth.from) !== getAddress(account)) {
    throw new Error('The signed authorization does not match the requirement. Not sending.');
  }
  const http = new x402HTTPClient(client);
  const res = await fetch(plan.url, { headers: http.encodePaymentSignatureHeader(payload) });
  const body = await res.text();
  let settleTx: string | null = null;
  try { settleTx = http.getPaymentSettleResponse((n) => res.headers.get(n)).transaction ?? null; } catch { /* not settled */ }
  return { status: res.status, body, settleTx };
}

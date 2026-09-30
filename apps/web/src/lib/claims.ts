/**
 * Creator actions: collect trading fees (Doppler initializer.collectFees — pays the caller's share),
 * claim escrow (FeeEscrow.claim, creator only), release vesting (DopplerERC20 release(scheduleId)).
 * Each action: simulate → (UI confirmation) → send with gas = estimate × 1.1.
 * Service settings: JSON messages from packages/shared, signed by the on-chain creator.
 */
import type { Address, Hex, PublicClient, WalletClient } from 'viem';
import { INITIALIZER, serviceCreateMessage, serviceSettingsMessage, serviceUpdateMessage, withBuffer } from '@astralaunch/shared';

const initializerAbi = [{ type: 'function', name: 'collectFees', stateMutability: 'nonpayable', inputs: [{ name: 'poolId', type: 'bytes32' }],
  outputs: [{ name: 'fees0', type: 'uint128' }, { name: 'fees1', type: 'uint128' }] }] as const;
const escrowAbi = [{ type: 'function', name: 'claim', stateMutability: 'nonpayable', inputs: [{ name: 'asset', type: 'address' }], outputs: [] }] as const;
const tokenAbi = [
  { type: 'function', name: 'getScheduleIdsOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256[]' }] },
  { type: 'function', name: 'computeAvailableVestedAmount', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'release', stateMutability: 'nonpayable', inputs: [{ name: 'scheduleId', type: 'uint256' }], outputs: [] },
] as const;

export interface PreparedTx {
  label: string; contract: Address; fn: string; args: string[]; gas: bigint; gasPrice: bigint;
  send: () => Promise<Hex>;
}

async function prepare(pc: PublicClient, wc: WalletClient, account: Address, label: string, call: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }): Promise<PreparedTx> {
  const { request } = await pc.simulateContract({ account, ...call } as never);
  const gas = withBuffer(await pc.estimateContractGas({ account, ...call } as never));
  const gasPrice = await pc.getGasPrice();
  return {
    label, contract: call.address, fn: call.functionName, args: call.args.map(String), gas, gasPrice,
    send: async () => {
      const hash = await wc.writeContract({ ...(request as object), chain: wc.chain ?? null, gas } as never);
      const r = await pc.waitForTransactionReceipt({ hash });
      if (r.status !== 'success') throw new Error(`${label} reverted (${hash})`);
      return hash;
    },
  };
}

export const prepareCollectFees = (pc: PublicClient, wc: WalletClient, account: Address, poolId: Hex) =>
  prepare(pc, wc, account, 'Collect trading fees', { address: INITIALIZER as Address, abi: initializerAbi, functionName: 'collectFees', args: [poolId] });

export const prepareEscrowClaim = (pc: PublicClient, wc: WalletClient, account: Address, escrow: Address, asset: Address) =>
  prepare(pc, wc, account, 'Claim escrow', { address: escrow, abi: escrowAbi, functionName: 'claim', args: [asset] });

/** Release the first vesting schedule with an available amount. */
export async function prepareRelease(pc: PublicClient, wc: WalletClient, account: Address, asset: Address) {
  const ids = await pc.readContract({ address: asset, abi: tokenAbi, functionName: 'getScheduleIdsOf', args: [account] });
  for (const id of ids) {
    const avail = await pc.readContract({ address: asset, abi: tokenAbi, functionName: 'computeAvailableVestedAmount', args: [account, id] });
    if (avail > 0n) return prepare(pc, wc, account, 'Release vested tokens', { address: asset, abi: tokenAbi, functionName: 'release', args: [id] });
  }
  throw new Error('Nothing is releasable yet (the 30-day cliff may not have passed).');
}

/** Signed service create or update (the server only accepts the on-chain creator's signature). */
/**
 * Create (POST) or update (PATCH) the token's service, signed by the creator ("one API link" model).
 * The server calls the link once and refuses it with a readable message if it does not answer 2xx.
 * On an update, only the fields that are set are sent (an empty key keeps the stored one).
 */
export async function saveService(wc: WalletClient, account: Address, apiBase: string, s: {
  existingId?: string; asset: Address; slug: string; name: string;
  priceUsdc?: bigint; apiLink?: string; wholeDomain?: boolean; apiKey?: { header: string; value: string };
}) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const link = s.apiLink ? { apiLink: s.apiLink, ...(s.wholeDomain ? { wholeDomain: true } : {}) } : {};
  const key = s.apiKey ? { apiKeyHeader: s.apiKey.header, apiKeyValue: s.apiKey.value } : {};
  let url: string, method: 'POST' | 'PATCH', body: Record<string, unknown>;
  if (s.existingId) {
    const fields = { ...(s.priceUsdc !== undefined ? { priceUsdc: s.priceUsdc.toString() } : {}), ...link, ...key, issuedAt };
    if (Object.keys(fields).length === 1) throw new Error('Nothing to save: change the link, the price or the API key.');
    const signature = await wc.signMessage({ account, message: serviceUpdateMessage(s.existingId, s.asset, fields) });
    url = `${apiBase}/api/services/${s.existingId}`; method = 'PATCH'; body = { ...fields, signature };
  } else {
    if (!s.apiLink || s.priceUsdc === undefined) throw new Error('Paste your API link and set a price.');
    const fields = { asset: s.asset, slug: s.slug, name: s.name, priceUsdc: s.priceUsdc.toString(), ...link, ...key, issuedAt };
    const signature = await wc.signMessage({ account, message: serviceCreateMessage(fields) });
    url = `${apiBase}/api/services`; method = 'POST'; body = { ...fields, signature };
  }
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({})) as { error?: string };
  if (!res.ok) throw new Error(out.error ?? `Service save failed (${res.status})`);
  return out;
}

/** Private service settings (creator only, one signature): the pasted link, key header, protect secret, probe result. */
export interface ServiceSettings {
  id: string; slug: string; priceUsdc: string; examplePath: string | null;
  apiLink: string | null; wholeDomain: boolean; legacyUpstream: boolean;
  apiKey: { header: string; set: true } | null;
  protect: { header: string; secret: string };
  protection: { status: 'protected' | 'unprotected' | null; checkedAt: string | null };
  responseKind: string | null; responseContentType: string | null;
}

export async function loadServiceSettings(wc: WalletClient, account: Address, apiBase: string, serviceId: string, asset: Address): Promise<ServiceSettings> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const signature = await wc.signMessage({ account, message: serviceSettingsMessage(serviceId, asset, issuedAt) });
  const res = await fetch(`${apiBase}/api/services/${serviceId}/settings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ issuedAt, signature }),
  });
  const out = await res.json().catch(() => ({})) as ServiceSettings & { error?: string };
  if (!res.ok) throw new Error(out.error ?? `Could not load the service settings (${res.status})`);
  return out;
}

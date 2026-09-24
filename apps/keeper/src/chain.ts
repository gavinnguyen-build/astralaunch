import { config } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  getAddress,
  http,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { withBuffer } from '@revpad/shared';
import { INITIALIZER as INITIALIZER_ADDR } from '@revpad/shared';
import { assertCanSpend, recordSpend, alertIfExpensive } from './spend.js';

config({ path: '../../.env' });
config({ path: '.env', override: false });

function need(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env var ${k}`);
  return v;
}

export const RPC_URL   = need('MONAD_RPC_URL');
export const CHAIN_ID  = Number(process.env.MONAD_CHAIN_ID ?? 143);
export const REGISTRY  = need('REVPAD_REGISTRY_ADDRESS') as Address;
export const ESCROW    = need('FEE_ESCROW_ADDRESS') as Address;
export const VAULT     = need('BUYBACK_VAULT_ADDRESS') as Address;
export const PLATFORM_FEE_RECEIVER = need('PLATFORM_FEE_RECEIVER_ADDRESS') as Address;

const monad = defineChain({
  id: CHAIN_ID,
  name: 'Monad',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

export const publicClient = createPublicClient({ chain: monad, transport: http(RPC_URL) });

const account = privateKeyToAccount(need('KEEPER_PRIVATE_KEY') as `0x${string}`);
const baseWallet = createWalletClient({ account, chain: monad, transport: http(RPC_URL) });

// ── Dry-run mode ────────────────────────────────────────────────────────────

export const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true';

// ── Cached gas price (refreshed per tick) ───────────────────────────────────

let cachedGasPrice = 0n;

/** Refresh gas price from the latest block. Call once per tick. */
export async function refreshGasPrice(): Promise<void> {
  cachedGasPrice = await publicClient.getGasPrice();
}

// ── Wallet balance ──────────────────────────────────────────────────────────

let walletBalance = 0n;

/** Refresh keeper wallet balance. Call once per tick. */
export async function refreshWalletBalance(): Promise<bigint> {
  walletBalance = await publicClient.getBalance({ address: account.address });
  return walletBalance;
}

export function getWalletBalance(): bigint {
  return walletBalance;
}

// ── Doppler initializer ─────────────────────────────────────────────────────

export const INITIALIZER = INITIALIZER_ADDR as Address;

const initializerAbi = [
  {
    type: 'function', name: 'collectFees', stateMutability: 'nonpayable',
    inputs: [{ name: 'poolId', type: 'bytes32' }],
    outputs: [{ name: 'fees0', type: 'uint128' }, { name: 'fees1', type: 'uint128' }],
  },
] as const;

/**
 * Simulate collectFees via eth_call to read pending fees for a beneficiary
 * without sending a tx. Returns (fees0, fees1); caller must determine which is USDC.
 */
export async function simulatePendingFees(
  poolId: `0x${string}`,
  beneficiary: Address,
): Promise<{ fees0: bigint; fees1: bigint }> {
  try {
    const { result } = await publicClient.simulateContract({
      address: INITIALIZER,
      abi: initializerAbi,
      functionName: 'collectFees',
      args: [poolId],
      account: beneficiary,
    });
    return { fees0: result[0], fees1: result[1] };
  } catch {
    return { fees0: 0n, fees1: 0n };
  }
}

// ── Send transaction ────────────────────────────────────────────────────────

export interface TxResult {
  hash: `0x${string}`;
  gasBuffered: bigint;
  monCost: bigint;
}

const DRY_RUN_HASH = '0x0000000000000000000000000000000000000000000000000000000000000001' as `0x${string}`;

/** Send a tx with gas estimate x 1.1 (Monad bills gas limit, CLAUDE.md rule 6). */
export async function sendTx(args: Parameters<typeof baseWallet.writeContract>[0]): Promise<TxResult> {
  const gas = await publicClient.estimateContractGas({ account, ...args } as any);
  const gasBuffered = withBuffer(gas);
  const monCost = gasBuffered * (cachedGasPrice || 1n);

  const label = `${(args as any).functionName}@${(args as any).address}`;

  // Spend guard check
  await assertCanSpend(monCost, walletBalance);

  if (DRY_RUN) {
    console.log(JSON.stringify({
      dryRun: true,
      fn: (args as any).functionName,
      to: (args as any).address,
      gas: gas.toString(),
      gasBuffered: gasBuffered.toString(),
      monCost: formatEther(monCost),
      ts: new Date().toISOString(),
    }));
    return { hash: DRY_RUN_HASH, gasBuffered, monCost: 0n };
  }

  console.log(JSON.stringify({
    tx: 'sending',
    fn: (args as any).functionName,
    to: (args as any).address,
    gas: gas.toString(),
    gasBuffered: gasBuffered.toString(),
    monCost: formatEther(monCost),
    ts: new Date().toISOString(),
  }));

  const hash = await baseWallet.writeContract({ ...args, gas: gasBuffered } as any);

  // Record actual spend and alert if expensive
  recordSpend(monCost);
  await alertIfExpensive(monCost, label);

  return { hash, gasBuffered, monCost };
}

// ── Startup contract verification ──────────────────────────────────────────
const adminAbi = [{ type: 'function', name: 'admin', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }] as const;

/** Verify all contract addresses have code, admin wiring, and dryRun flag. */
export async function verifyContracts(): Promise<void> {
  // Check dryRun flag in contracts JSON if CONTRACTS_JSON_PATH is set.
  const contractsPath = process.env.CONTRACTS_JSON_PATH;
  if (contractsPath && existsSync(contractsPath)) {
    const contracts = JSON.parse(readFileSync(contractsPath, 'utf8'));
    if (contracts.dryRun === true) {
      throw new Error(
        `FATAL: ${contractsPath} has "dryRun": true. ` +
        `These addresses are from a simulation, not a real deployment. ` +
        `Re-run Deploy.s.sol with --broadcast to produce a real deployment.`
      );
    }
  }

  const addrs: Array<{ name: string; addr: Address }> = [
    { name: 'RevpadRegistry', addr: REGISTRY },
    { name: 'FeeEscrow', addr: ESCROW },
    { name: 'BuybackVault', addr: VAULT },
    { name: 'PlatformFeeReceiver', addr: PLATFORM_FEE_RECEIVER },
  ];

  for (const { name, addr } of addrs) {
    const code = await publicClient.getCode({ address: addr });
    if (!code || code === '0x') {
      throw new Error(`FATAL: ${name} (${addr}) has no bytecode on chain ${CHAIN_ID}. Wrong address or network.`);
    }
  }

  const expectedAdmin = process.env.ADMIN_ADDRESS;
  if (expectedAdmin) {
    const expected = getAddress(expectedAdmin);
    for (const { name, addr } of [
      { name: 'RevpadRegistry', addr: REGISTRY },
      { name: 'PlatformFeeReceiver', addr: PLATFORM_FEE_RECEIVER },
    ]) {
      const actual = await publicClient.readContract({ address: addr, abi: adminAbi, functionName: 'admin' });
      if (getAddress(actual) !== expected) {
        throw new Error(
          `FATAL: ${name}.admin() = ${actual}, expected ADMIN_ADDRESS = ${expected}. Wrong deployment or network.`
        );
      }
    }
    console.log(`[keeper] Admin wiring verified: ${expected}`);
  }

  console.log(`[keeper] Contract addresses verified on chain ${CHAIN_ID}`);
}

export { account };

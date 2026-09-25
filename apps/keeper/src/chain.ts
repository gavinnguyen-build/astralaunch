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
import { withBuffer } from '@astralaunch/shared';
import { INITIALIZER as INITIALIZER_ADDR, WMON as WMON_ADDR } from '@astralaunch/shared';
import { assertCanSpend, recordSpend, alertIfExpensive } from './spend.js';

config({ path: '../../.env' });
config({ path: '.env', override: false });

function need(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env var ${k}`);
  return v;
}

/** Accept both new and legacy env var name for the registry address. */
function needRegistry(): string {
  const v = process.env.ASTRALAUNCH_REGISTRY_ADDRESS;
  if (!v) throw new Error('Missing env var ASTRALAUNCH_REGISTRY_ADDRESS');
  return v;
}

export const RPC_URL   = need('MONAD_RPC_URL');
export const CHAIN_ID  = Number(process.env.MONAD_CHAIN_ID ?? 143);
export const REGISTRY  = needRegistry() as Address;
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

// ── WMON address ────────────────────────────────────────────────────────────

export const WMON = WMON_ADDR as Address;

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
  {
    type: 'function', name: 'getShares', stateMutability: 'view',
    inputs: [{ name: 'poolId', type: 'bytes32' }, { name: 'beneficiary', type: 'address' }],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
] as const;

/**
 * Simulate collectFees via eth_call to read TOTAL pending fees for the pool.
 * Returns (fees0, fees1); caller must determine which is USDC/WMON.
 *
 * NOTE: collectFees returns the TOTAL pool fees regardless of the calling account.
 * To get per-beneficiary pending, use getBeneficiaryShare() and multiply.
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

/**
 * Read the WAD share for a beneficiary on a pool via the initializer's
 * getShares(poolId, beneficiary) view function.
 */
export async function getBeneficiaryShare(
  poolId: `0x${string}`,
  beneficiary: Address,
): Promise<bigint> {
  try {
    return await publicClient.readContract({
      address: INITIALIZER,
      abi: initializerAbi,
      functionName: 'getShares',
      args: [poolId, beneficiary],
    });
  } catch {
    return 0n;
  }
}

// ── AstralaunchRegistry ABI (for numeraire lookups + initializer proposals) ─

const registryAbi = [
  {
    type: 'function', name: 'assetNumeraires', stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{ name: 'numeraire', type: 'address' }],
  },
  {
    type: 'function', name: 'pendingInitializer', stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'initializer', type: 'address' },
      { name: 'adapter', type: 'address' },
      { name: 'executableAt', type: 'uint256' },
    ],
  },
] as const;

/**
 * Read the numeraire address for an asset from AstralaunchRegistry.
 * Returns the numeraire (USDC or WMON), or zero address if not registered.
 */
export async function getAssetNumeraire(asset: Address): Promise<Address> {
  try {
    return await publicClient.readContract({
      address: REGISTRY,
      abi: registryAbi,
      functionName: 'assetNumeraires',
      args: [asset],
    }) as Address;
  } catch {
    return '0x0000000000000000000000000000000000000000' as Address;
  }
}

/**
 * Read the pending initializer proposal from AstralaunchRegistry.
 * Returns { initializer, adapter, executableAt } or null if no active proposal.
 */
export async function getPendingInitializerProposal(): Promise<{
  initializer: Address;
  adapter: Address;
  executableAt: bigint;
} | null> {
  try {
    const result = await publicClient.readContract({
      address: REGISTRY,
      abi: registryAbi,
      functionName: 'pendingInitializer',
    });
    const [initializer, adapter, executableAt] = result as [Address, Address, bigint];
    if (executableAt === 0n) return null;
    return { initializer, adapter, executableAt };
  } catch {
    return null;
  }
}

export { registryAbi };

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
    { name: 'AstralaunchRegistry', addr: REGISTRY },
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
      { name: 'AstralaunchRegistry', addr: REGISTRY },
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

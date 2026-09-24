import { config as loadEnv } from 'dotenv';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  http,
  parseEther,
  publicActions,
  type Address,
  type Hex,
} from 'viem';
import { mnemonicToAccount } from 'viem/accounts';

loadEnv({ path: '.env.anvil' });

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env.anvil`);
  return v;
}

export const RPC_URL = process.env.ANVIL_RPC_URL ?? 'http://127.0.0.1:8545';
export const CHAIN_ID = Number(process.env.CHAIN_ID ?? 143);
export const NETWORK = `eip155:${CHAIN_ID}` as const;
export const USDC = need('USDC_ADDRESS') as Address;

export const monadFork = defineChain({
  id: CHAIN_ID,
  name: 'Monad (Anvil fork)',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  // Doppler SDK's getPendingFees calls callAggregate3, which reads chain.contracts.multicall3.
  // Multicall3 is deployed at the canonical address on Monad mainnet.
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
});

export const publicClient = createPublicClient({ chain: monadFork, transport: http(RPC_URL) });
export const testClient = createTestClient({ chain: monadFork, mode: 'anvil', transport: http(RPC_URL) });

// Anvil's default dev mnemonic. Public test keys: never use on a real network.
const MNEMONIC = 'test test test test test test test test test test test junk';

export const ROLES = {
  creator: 0,
  treasury: 1,
  escrowStub: 2, // stands in for FeeEscrow until the contract exists
  buybackStub: 3, // stands in for BuybackVault
  trader: 4,
  agent: 5, // pays for x402 calls
  facilitator: 6,
  routerStub: 7, // stands in for a RevenueRouter (x402 payTo)
} as const;
export type Role = keyof typeof ROLES;

export function account(role: Role) {
  return mnemonicToAccount(MNEMONIC, { addressIndex: ROLES[role] });
}

export function wallet(role: Role) {
  return createWalletClient({ account: account(role), chain: monadFork, transport: http(RPC_URL) }).extend(publicActions);
}

// ---- Revpad economics (must match SPEC §4) ----
export const WAD = 10n ** 18n;
export const POOL_FEE = Number(process.env.POOL_FEE ?? 20000); // 2% in Uniswap v4 fee units
export const TICK_SPACING = Number(process.env.TICK_SPACING ?? 200); // custom fee => explicit tick spacing
export const SHARES = {
  doppler: parseEther('0.05'),
  creator: parseEther('0.35'),
  escrow: parseEther('0.20'),
  buyback: parseEther('0.10'),
  treasury: parseEther('0.30'),
};
export const SUPPLY = 1_000_000_000n * WAD;
export const POOL_TOKENS = (SUPPLY * 85n) / 100n;
export const VESTED_TOKENS = SUPPLY - POOL_TOKENS; // 15%
export const DAY = 86_400;
export const START_MCAP_USD = Number(process.env.START_MCAP_USD ?? 10_000); // open decision O1
export const GAS_BUFFER_BPS = 11_000n; // estimate x 1.1 (Monad bills the gas limit)

export function withBuffer(gas: bigint): bigint {
  return (gas * GAS_BUFFER_BPS) / 10_000n;
}

// ---- tiny state stores shared between scripts ----
const STATE_DIR       = '.anvil-state';
const STATE_FILE      = `${STATE_DIR}/state.json`;
const DEFAULT_CONTRACTS_FILE = `${STATE_DIR}/contracts.json`;
/** Override with CONTRACTS_JSON_PATH env var for mainnet or custom paths. */
const CONTRACTS_FILE  = process.env.CONTRACTS_JSON_PATH ?? DEFAULT_CONTRACTS_FILE;

export type KitState = {
  token?: Address;
  poolId?: Hex;
  poolKey?: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
  launchTx?: Hex;
  launchGasUsed?: string;
  buyVolumeUsdc?: string;
  sellVolumeToken?: string;
};

export function loadState(): KitState {
  if (!existsSync(STATE_FILE)) return {};
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
}

export type ContractsState = {
  deployer?: Address;
  deployerStartNonce?: number;
  escrow?: Address;
  vault?: Address;
  platformFeeReceiver?: Address;
  routerImpl?: Address;
  registry?: Address;
  treasury?: Address;
  admin?: Address;
};

export function loadContracts(): ContractsState {
  if (!existsSync(CONTRACTS_FILE)) {
    throw new Error(
      `Contracts file not found: ${CONTRACTS_FILE}\n` +
      `Set CONTRACTS_JSON_PATH env var or run Deploy.s.sol first.\n` +
      `  Fork:    forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --private-key $PRIVATE_KEY\n` +
      `  Mainnet: DEPLOY_OUTPUT=deployments/monad-mainnet.json forge script ...`
    );
  }
  return JSON.parse(readFileSync(CONTRACTS_FILE, 'utf8'));
}

export function saveState(patch: Partial<KitState>) {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  const next = { ...loadState(), ...patch };
  writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  return next;
}

export const erc20Abi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const;

export async function balanceOf(tokenAddr: Address, who: Address): Promise<bigint> {
  return publicClient.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'balanceOf', args: [who] });
}

export function pass(ok: boolean, label: string, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  return ok;
}

export async function assertFork() {
  const id = await publicClient.getChainId();
  if (id !== CHAIN_ID) throw new Error(`RPC ${RPC_URL} reports chainId ${id}, expected ${CHAIN_ID}. Is the Anvil fork running?`);
}

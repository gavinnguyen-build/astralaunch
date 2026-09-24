import { config } from 'dotenv';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { withBuffer } from '@revpad/shared';

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

/** Send a tx with gas estimate × 1.1 (Monad bills gas limit, CLAUDE.md rule 6). */
export async function sendTx(args: Parameters<typeof baseWallet.writeContract>[0]): Promise<`0x${string}`> {
  const gas = await publicClient.estimateContractGas({ account, ...args } as any);
  return baseWallet.writeContract({ ...args, gas: withBuffer(gas) } as any);
}

// ── Startup contract verification ──────────────────────────────────────────
const adminAbi = [{ type: 'function', name: 'admin', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }] as const;

/** Verify all contract addresses have code and admin wiring matches ADMIN_ADDRESS (if set). */
export async function verifyContracts(): Promise<void> {
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

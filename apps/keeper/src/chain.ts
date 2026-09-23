import { config } from 'dotenv';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
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

export { account };

/** viem clients for the connected Privy wallet on the configured chain (reads via VITE_RPC_URL). */
import { createPublicClient, createWalletClient, custom, defineChain, getAddress, http, type Address, type PublicClient, type WalletClient } from 'viem';
import { RPC_URL } from '../env.js';
import type { ChainConfig } from './launch.js';

export interface PrivyWallet {
  address: string;
  switchChain(id: number): Promise<void>;
  getEthereumProvider(): Promise<unknown>;
}

export interface Clients { publicClient: PublicClient; walletClient: WalletClient; account: Address; config: ChainConfig }

export async function walletClients(wallet: PrivyWallet, config: ChainConfig): Promise<Clients> {
  const chain = defineChain({ id: config.chainId, name: 'Monad', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } });
  await wallet.switchChain(config.chainId);
  const provider = await wallet.getEthereumProvider();
  const account = getAddress(wallet.address);
  return {
    publicClient: createPublicClient({ chain, transport: http(RPC_URL) }) as PublicClient,
    walletClient: createWalletClient({ account, chain, transport: custom(provider as never) }),
    account, config,
  };
}

export const errMsg = (e: unknown) => (e as { shortMessage?: string })?.shortMessage ?? (e instanceof Error ? e.message : String(e));

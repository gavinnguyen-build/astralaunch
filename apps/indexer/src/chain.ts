import { createPublicClient, defineChain, http } from 'viem';
import { CHAIN_ID, MONAD_RPC_URL } from './config.js';

export const monad = defineChain({
  id: CHAIN_ID,
  name: 'Monad',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [MONAD_RPC_URL] } },
});

export const publicClient = createPublicClient({
  chain: monad,
  transport: http(MONAD_RPC_URL),
});

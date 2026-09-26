/** Harness only: the real Site module, with the connected wallet replaced by the fork wallet. */
import { forkWallet } from './wallet.js';
export * from '../../src/components/Site.tsx';

const wallet = forkWallet(new URLSearchParams(location.search).get('account') ?? '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65');
export function useConnectedWallet() { return wallet; }
export function useWalletAddress() { return wallet.address; }
export function useLogin() { return null; }
export const PRIVY_ENABLED = true;

/** LOCAL fork "wallet": forwards to Anvil, which signs for its unlocked dev accounts (no key in the page). */
import { RPC_URL } from '../../src/env.js';
import type { PrivyWallet } from '../../src/lib/wallet.js';

if (!/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(RPC_URL)) throw new Error(`fork only (VITE_RPC_URL=${RPC_URL})`);
declare global { interface Window { __rejectNext?: boolean; __walletLog: string[] } }
window.__walletLog = [];
let id = 0;

export function forkWallet(account: string): PrivyWallet {
  const provider = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      if (/^eth_(sendTransaction|signTypedData_v4)$/.test(method)) {
        window.__walletLog.push(method);
        if (window.__rejectNext) { window.__rejectNext = false; throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); }
      }
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [account];
      const r = await fetch(RPC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params ?? [] }) });
      const j = await r.json() as { result?: unknown; error?: { message: string; code: number } };
      if (j.error) throw Object.assign(new Error(j.error.message), j.error);
      return j.result;
    },
  };
  return { address: account, switchChain: async () => {}, getEthereumProvider: async () => provider };
}

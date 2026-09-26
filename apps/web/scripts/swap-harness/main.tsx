/**
 * LOCAL fork harness for components/SwapPanel.tsx (no server, no Privy). The "wallet" forwards every
 * request to Anvil, which signs for its unlocked dev accounts; set window.__rejectNext = true to make
 * the next wallet prompt fail with a user rejection (code 4001). Refuses any non-local RPC.
 *
 *   VITE_RPC_URL=http://127.0.0.1:8545 pnpm exec vite --config scripts/swap-harness/vite.config.ts
 *   open http://localhost:3020/?account=0x…
 */
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { USDC, WMON } from '@astralaunch/shared';
import { SwapPanel } from '../../src/components/SwapPanel.js';
import type { ChainConfig } from '../../src/lib/launch.js';
import type { PrivyWallet } from '../../src/lib/wallet.js';
import { forkWallet } from './wallet.js';
import dep from '../../../../packages/contracts/deployments/monad-mainnet.json';

const account = new URLSearchParams(location.search).get('account') ?? '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65';
const config: ChainConfig = {
  chainId: 143,
  contracts: { registry: dep.registry as never, escrow: dep.escrow as never, vault: dep.vault as never, platformFeeReceiver: dep.platformFeeReceiver as never },
  tokens: { usdc: USDC, wmon: WMON }, monUsdOracle: '0x0000000000000000000000000000000000000000',
  launchFee: { mon: 10, wei: '0', treasury: '0x0000000000000000000000000000000000000000', maxPer24h: 3 },
};
const wallet: PrivyWallet = forkWallet(account);
const qc = new QueryClient();
const pairs = [
  { id: 'usdc', asset: '0x30Ae380593A04C14aBFa994969B718a78A6105aD', symbol: 'SIGHT', numSym: 'USDC' as const },
  { id: 'mon', asset: '0x2686619d5569AEbcdfeC774e8a2167dE78376dDf', symbol: 'FEED', numSym: 'MON' as const },
];
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={qc}>
    <div style={{ display: 'flex', gap: 24, padding: 24, alignItems: 'flex-start' }}>
      {pairs.map((x) => (
        <div key={x.id} id={`pair-${x.id}`} style={{ width: 380 }}>
          <SwapPanel asset={x.asset as `0x${string}`} symbol={x.symbol} numSym={x.numSym} config={config} wallet={wallet} login={null}
            usdPerNum={x.numSym === 'USDC' ? 1 : null} tokenUsd={null} />
        </div>
      ))}
    </div>
  </QueryClientProvider>,
);

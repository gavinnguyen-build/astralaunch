import React from 'react';
import ReactDOM from 'react-dom/client';
import { PrivyProvider } from '@privy-io/react-auth';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App.js';
import { PRIVY_APP_ID, CHAIN_ID, RPC_URL } from './env.js';
import './index.css';

const qc = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});

const app = (
  <QueryClientProvider client={qc}>
    <App />
  </QueryClientProvider>
);

// Read-only pages work without a Privy app id (wallet features show as unavailable).
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {!PRIVY_APP_ID ? app : (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods:         ['wallet', 'email', 'twitter'],
        appearance:           { theme: 'dark' },
        embeddedWallets:      { createOnLogin: 'users-without-wallets' },
        defaultChain: {
          id:   CHAIN_ID,
          name: 'Monad',
          nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
          rpcUrls: { default: { http: [RPC_URL] } },
        } as any,
        supportedChains: [
          {
            id:   CHAIN_ID,
            name: 'Monad',
            nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
            rpcUrls: { default: { http: [RPC_URL] } },
          } as any,
        ],
      }}
    >
      {app}
    </PrivyProvider>
    )}
  </React.StrictMode>,
);

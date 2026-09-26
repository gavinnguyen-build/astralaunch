/**
 * LOCAL fork harness for the real chart page (pages/TokenChart.tsx) against a fork server:
 *   API_PROXY_TARGET=http://127.0.0.1:3101 VITE_RPC_URL=http://127.0.0.1:8545 \
 *     pnpm exec vite --config scripts/swap-harness/vite.config.ts
 *   open http://localhost:3020/chart.html?asset=0x…&account=0x…
 */
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TokenChart from '../../src/pages/TokenChart.js';

const asset = new URLSearchParams(location.search).get('asset') ?? '';
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient()}>
    <MemoryRouter initialEntries={[`/token/${asset}/chart`]}>
      <Routes><Route path="/token/:asset/chart" element={<TokenChart />} /></Routes>
    </MemoryRouter>
  </QueryClientProvider>,
);

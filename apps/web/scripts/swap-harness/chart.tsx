/**
 * LOCAL fork harness for real pages (chart, token, home) against a fork server, with the fork wallet:
 *   API_PROXY_TARGET=http://127.0.0.1:3101 VITE_RPC_URL=http://127.0.0.1:8545 \
 *     pnpm exec vite --config scripts/swap-harness/vite.config.ts
 *   open http://localhost:3020/chart.html?asset=0x…&account=0x…            (chart page)
 *        http://localhost:3020/chart.html?path=/token/0x…  or  ?path=/       (token page, home)
 */
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TokenChart from '../../src/pages/TokenChart.js';
import Token from '../../src/pages/Token.js';
import Home from '../../src/pages/Home.js';
import Discover from '../../src/pages/Discover.js';
import Leaderboard from '../../src/pages/Leaderboard.js';

const qs = new URLSearchParams(location.search);
const path = qs.get('path') ?? `/token/${qs.get('asset') ?? ''}/chart`;
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient()}>
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/discover" element={<Discover />} />
        <Route path="/leaderboard" element={<Leaderboard />} />
        <Route path="/token/:asset" element={<Token />} />
        <Route path="/token/:asset/chart" element={<TokenChart />} />
      </Routes>
    </MemoryRouter>
  </QueryClientProvider>,
);

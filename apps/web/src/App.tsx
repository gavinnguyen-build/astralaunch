import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Home from './pages/Home.js';
import Discover from './pages/Discover.js';
import Token from './pages/Token.js';
import TokenChart from './pages/TokenChart.js';
import Leaderboard from './pages/Leaderboard.js';
import Creator from './pages/Creator.js';
import Launch from './pages/Launch.js';
import Docs from './pages/Docs.js';
import { Empty } from './components/State.js';
import { PageShell } from './pages/Token.js';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/"                    element={<Home />} />
        <Route path="/discover"            element={<Discover />} />
        <Route path="/token/:asset"        element={<Token />} />
        <Route path="/token/:asset/chart"  element={<TokenChart />} />
        <Route path="/leaderboard"         element={<Leaderboard />} />
        <Route path="/creator"             element={<Creator />} />
        <Route path="/launch"              element={<Launch />} />
        <Route path="/docs"                element={<Docs />} />
        <Route path="*"                    element={<PageShell><Empty>Page not found.</Empty></PageShell>} />
      </Routes>
    </BrowserRouter>
  );
}

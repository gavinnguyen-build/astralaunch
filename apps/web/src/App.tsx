import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout.js';
import Explore from './pages/Explore.js';
import Token from './pages/Token.js';
import Launch from './pages/Launch.js';
import Creator from './pages/Creator.js';
import Explorer from './pages/Explorer.js';
import Docs from './pages/Docs.js';

export default function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/"            element={<Explore />} />
          <Route path="/launch"      element={<Launch />} />
          <Route path="/t/:asset"    element={<Token />} />
          <Route path="/creator"     element={<Creator />} />
          <Route path="/explorer"    element={<Explorer />} />
          <Route path="/docs"        element={<Docs />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}

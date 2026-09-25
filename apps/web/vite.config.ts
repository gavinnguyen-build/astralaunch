import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
// API server for the dev proxy (default: local server on :3001).
const API = process.env.API_PROXY_TARGET ?? 'http://localhost:3001';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@astralaunch/shared': resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': { target: API, changeOrigin: true },
      // x402 gateway only: '/s' as a plain prefix would also swallow '/src/*' module requests.
      '^/s/': { target: API, changeOrigin: true },
    },
  },
  build: { target: 'esnext' },
});

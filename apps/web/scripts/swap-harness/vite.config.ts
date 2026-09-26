import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// LOCAL fork harness for the swap panel (main.tsx) and the chart page (chart.tsx). Not part of the app build.
export default defineConfig({
  root: __dirname,
  envDir: resolve(__dirname, '../../.harness-env-none'),
  plugins: [react()],
  resolve: {
    alias: [
      { find: '@astralaunch/shared', replacement: resolve(__dirname, '../../../../packages/shared/src/index.ts') },
      // chart.html: every `…/Site.js` import gets the fork wallet (site-stub.tsx imports the real Site.tsx)
      { find: /^(\.\.?\/)+(components\/)?Site\.js$/, replacement: resolve(__dirname, 'site-stub.tsx') },
    ],
  },
  server: {
    port: 3020, strictPort: true, fs: { allow: [resolve(__dirname, '../../../..')] },
    proxy: { '/api': { target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3101', changeOrigin: true } },
  },
});

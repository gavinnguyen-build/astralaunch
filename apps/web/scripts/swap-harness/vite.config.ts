import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// LOCAL fork harness for the swap panel (see main.tsx). Not part of the app build.
export default defineConfig({
  root: __dirname,
  envDir: resolve(__dirname, '../../.harness-env-none'),
  plugins: [react()],
  resolve: { alias: { '@astralaunch/shared': resolve(__dirname, '../../../../packages/shared/src/index.ts') } },
  server: { port: 3020, strictPort: true, fs: { allow: [resolve(__dirname, '../../../..')] } },
});

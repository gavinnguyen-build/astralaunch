import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@revpad/shared': path.resolve(import.meta.dirname!, '../../packages/shared/src/index.ts'),
    },
  },
  test: {
    include: ['src/__tests__/**/*.test.ts'],
  },
});

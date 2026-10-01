import { defineConfig } from 'vitest/config';
import path from 'path';

// Unit tests for framework-free helpers (src/**/*.test.ts). Pages and components are checked with the fork harness.
export default defineConfig({
  resolve: {
    alias: {
      '@astralaunch/shared': path.resolve(import.meta.dirname!, '../../packages/shared/src/index.ts'),
    },
  },
  test: {
    include: ['src/__tests__/**/*.test.ts'],
  },
});

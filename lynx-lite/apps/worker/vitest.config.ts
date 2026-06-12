import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
  resolve: {
    alias: {
      '@lynx-lite/data-collector': new URL('../../packages/data-collector/src/index.ts', import.meta.url).pathname,
    },
  },
});

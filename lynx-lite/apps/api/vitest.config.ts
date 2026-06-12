import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
  },
  resolve: {
    alias: {
      '@lynx-lite/pricing-engine': new URL('../../packages/pricing-engine/src/index.ts', import.meta.url).pathname,
      '@lynx-lite/data-collector': new URL('../../packages/data-collector/src/index.ts', import.meta.url).pathname,
    },
  },
});

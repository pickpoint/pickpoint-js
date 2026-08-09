import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@pickpoint/sdk/tracking': path.resolve(__dirname, 'src/tracking/index.ts'),
      '@pickpoint/sdk': path.resolve(__dirname, 'src/index.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 15_000,
  },
});

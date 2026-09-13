import { defineBaseConfig } from '@reviews/tooling/vitest';

export default defineBaseConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
    setupFiles: ['./test/setup.ts'],
  },
});

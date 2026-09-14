import { defineBaseConfig } from '@reviews/tooling/vitest';

export default defineBaseConfig({
  test: {
    include: ['lib/**/*.test.ts'],
  },
});

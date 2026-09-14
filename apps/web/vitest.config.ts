import { fileURLToPath } from 'node:url';
import { defineBaseConfig } from '@reviews/tooling/vitest';

export default defineBaseConfig({
  resolve: {
    // Mirrors tsconfig.json's "@/*": ["./*"] path alias so app code (which
    // uses "@/lib/..." imports, matching Next's own convention) resolves
    // the same way under Vitest as it does under Next's bundler.
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    include: ['**/*.test.ts'],
  },
});

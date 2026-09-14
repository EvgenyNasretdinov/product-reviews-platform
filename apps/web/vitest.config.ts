import { fileURLToPath } from 'node:url';
import { defineBaseConfig } from '@reviews/tooling/vitest';

export default defineBaseConfig({
  // Vitest's default esbuild transform already handles JSX in *.test.tsx
  // files; it just defaults to the classic runtime (requires `React` in
  // scope). This matches Next's own automatic-runtime compilation instead,
  // so a component test needs no `import React` it would otherwise never
  // use. Pulling in `@vitejs/plugin-react` for this one setting isn't
  // worth it: this workspace resolves two structurally distinct copies of
  // `vite` (via `@types/node` version skew across peer deps), and the
  // plugin's `Plugin<any>` type collides across them under `tsc --noEmit`.
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    // Mirrors tsconfig.json's "@/*": ["./*"] path alias so app code (which
    // uses "@/lib/..." imports, matching Next's own convention) resolves
    // the same way under Vitest as it does under Next's bundler.
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    include: ['**/*.test.ts', '**/*.test.tsx'],
    // The base config defaults to the 'node' environment, which is right
    // for the plain *.test.ts files (route handlers, the API client, the
    // session cookie parser) — none of them touch the DOM. Component tests
    // need a document, so rating-stars.test.tsx opts into jsdom itself via
    // a `// @vitest-environment jsdom` pragma rather than switching every
    // test in the package to jsdom for the sake of the one file that
    // renders React.
    setupFiles: ['./vitest.setup.ts'],
  },
});

import swc from 'unplugin-swc';
import { defineBaseConfig } from '@reviews/tooling/vitest';

export default defineBaseConfig({
  // See vitest.config.ts: Nest's DI needs real decorator metadata, which
  // esbuild's TS transform does not produce.
  plugins: [swc.vite()],
  test: {
    include: ['test/**/*.integration.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Every integration file shares one pair of containers (started once per
    // worker in global-setup.ts) and truncates the same tables between
    // tests. Running files concurrently would let one file's truncate wipe
    // rows another file is mid-assertion on, so files run one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});

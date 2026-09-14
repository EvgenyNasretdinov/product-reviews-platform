import swc from 'unplugin-swc';
import { defineBaseConfig } from '@reviews/tooling/vitest';

export default defineBaseConfig({
  // Vitest's default esbuild transform silently drops emitDecoratorMetadata
  // (esbuild doesn't implement it), which breaks Nest's constructor
  // injection wherever a provider is resolved by implicit type rather than
  // an explicit @Inject() token. swc.vite() reads experimentalDecorators
  // and emitDecoratorMetadata straight from tsconfig.json and reproduces
  // tsc's decorator metadata output instead.
  plugins: [swc.vite()],
  test: {
    include: ['src/**/*.test.ts'],
  },
});

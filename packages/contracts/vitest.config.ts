// Imported by relative path (not the `@reviews/tooling/vitest` package export) because
// Vite's config-file bundler treats bare specifiers as external and hands them to Node's
// native ESM loader, which cannot load a raw .ts file. A relative specifier lets esbuild
// inline and transpile the source instead.
import { defineBaseConfig } from '../tooling/vitest.base.ts';

export default defineBaseConfig();

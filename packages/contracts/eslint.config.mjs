import tooling from '@reviews/tooling/eslint';

export default [
  // Root-level config files aren't part of the package's tsconfig "src" project, so
  // typed-linting rules (which need a matching tsconfig project) can't apply to them.
  { ignores: ['vitest.config.ts', 'eslint.config.mjs'] },
  ...tooling,
];

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const CONFIG_FILE_GLOBS = ['*.config.mjs', '*.config.cjs', '*.config.js', '*.config.ts', '*.config.mts'];

/**
 * Shared ESLint flat config, instantiated once per consuming package.
 *
 * `tsconfigRootDir` must be the *consuming* package's own root
 * (its `import.meta.dirname`), passed in explicitly rather than inferred.
 * typescript-eslint's project service resolves every relative path — including
 * the `allowDefaultProject` globs below — against `tsconfigRootDir`. Because
 * this config is authored once here and merely re-used by every package,
 * typescript-eslint's usual auto-inference (triggered by reading
 * `tseslint.configs.recommendedTypeChecked`, which happens in *this* file) would
 * always resolve to `packages/tooling`, not to whichever package is actually
 * being linted — producing paths like `../contracts/eslint.config.mjs` that no
 * simple glob matches. Accepting the caller's directory sidesteps that
 * entirely: each package's config files resolve to their own plain filename.
 *
 * @param {string} tsconfigRootDir
 */
export function createConfig(tsconfigRootDir) {
  return tseslint.config(
    {
      ignores: ['**/dist/**', '**/.next/**', '**/coverage/**', '**/node_modules/**'],
    },
    js.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    {
      languageOptions: {
        parserOptions: {
          tsconfigRootDir,
          projectService: {
            // Root-level tool config files (vitest.config.ts, eslint.config.mjs,
            // etc.) typically sit outside every package's tsconfig "include"
            // (scoped to "src"), so they have no project to type-check against.
            // Route them to typescript-eslint's single-file "default project"
            // instead of erroring, so they still get full linting via every
            // non-type-aware rule.
            allowDefaultProject: CONFIG_FILE_GLOBS,
          },
        },
      },
      rules: {
        '@typescript-eslint/no-explicit-any': 'error',
        '@typescript-eslint/consistent-type-imports': 'error',
      },
    },
    {
      // The default-project fallback above builds an ad hoc single-file program
      // that does not share the package's real tsconfig compilerOptions, so its
      // type information is not trustworthy — e.g. it cannot resolve
      // `import.meta.dirname` and reports it as an error-typed value, tripping
      // rules like no-unsafe-argument on perfectly valid code. Type-aware rules
      // are therefore turned off for exactly these files, per typescript-eslint's
      // own documented pairing of `allowDefaultProject` with `disableTypeChecked`
      // (https://typescript-eslint.io/troubleshooting/typed-linting/#how-do-i-disable-type-checked-linting-for-a-file).
      // Every non-type-aware rule (no-unused-vars, consistent-type-imports, etc.)
      // still applies.
      files: CONFIG_FILE_GLOBS,
      ...tseslint.configs.disableTypeChecked,
    },
  );
}

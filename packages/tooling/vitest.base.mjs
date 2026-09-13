/** @typedef {import('vitest/config').UserConfig} UserConfig */

/**
 * @param {UserConfig} [overrides]
 * @returns {UserConfig}
 */
export function defineBaseConfig(overrides = {}) {
  return {
    ...overrides,
    test: {
      globals: true,
      environment: 'node',
      passWithNoTests: false,
      ...overrides.test,
    },
  };
}

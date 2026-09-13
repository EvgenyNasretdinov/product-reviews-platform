import type { UserConfig } from 'vitest/config';

export function defineBaseConfig(overrides: UserConfig = {}): UserConfig {
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

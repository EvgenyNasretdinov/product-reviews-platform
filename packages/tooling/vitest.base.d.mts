import type { UserConfig } from 'vitest/config';

/**
 * Base Vitest configuration shared by every package: Node environment, global
 * test APIs, and a hard failure when a project has no tests at all. Callers
 * spread their own `overrides` on top (deep-merged one level for `test`).
 */
export declare function defineBaseConfig(overrides?: UserConfig): UserConfig;

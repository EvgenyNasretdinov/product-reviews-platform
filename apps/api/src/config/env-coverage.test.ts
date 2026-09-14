import { describe, expect, it } from 'vitest';
import { BASE_TEST_ENV } from '../../test/harness.js';
import { envSchema } from './env.js';

// The two keys test/harness.ts's createTestApp() sets directly from the
// per-worker Testcontainers setup (see global-setup.ts), rather than
// defaulting in BASE_TEST_ENV.
const HARNESS_INJECTED_KEYS = new Set(['DATABASE_URL', 'REDIS_URL']);

describe('test harness env coverage', () => {
  it('gives every envSchema key a default in BASE_TEST_ENV, or the harness injects it', () => {
    // Derived from envSchema's own shape, not a second hand-written list —
    // a hardcoded expected-keys array here would just move the
    // maintenance problem this test exists to catch.
    const schemaKeys = Object.keys(envSchema.shape);
    const covered = new Set([...Object.keys(BASE_TEST_ENV), ...HARNESS_INJECTED_KEYS]);

    const uncovered = schemaKeys.filter((key) => !covered.has(key));

    // A failure here means a new env var was added to envSchema without a
    // matching default in test/harness.ts's BASE_TEST_ENV. That reopens the
    // leak fixed in the Task 5 review: BASE_TEST_ENV is the only thing that
    // resets process.env between createTestApp() calls, so any suite that
    // later overrides the new var leaves that override on process.env for
    // every subsequent call in the same worker — silently, and dependent on
    // file execution order.
    expect(uncovered).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { envSchema } from './env.js';

/**
 * The variables every worker integration test's `beforeAll` sets on
 * `process.env` itself, from the containers `test/global-setup.ts` starts
 * (see `boot.integration.test.ts`, `pipeline.integration.test.ts`, etc.) —
 * mirrors `apps/api/test/harness.ts`'s `HARNESS_INJECTED_KEYS`, except the
 * worker has no single shared harness function that does this in one
 * place, so every integration test file does it itself instead. Either
 * way, these three are never expected to have a schema default: a real
 * boot needs a real value for all three.
 */
const HARNESS_INJECTED_KEYS = new Set(['DATABASE_URL', 'RABBITMQ_URL', 'REDIS_URL']);

describe('envSchema coverage', () => {
  it('gives every envSchema key a default, or the test harness injects it', () => {
    // Derived from envSchema's own shape, not a second hand-written list —
    // a hardcoded expected-keys array here would just move the
    // maintenance problem this test exists to catch. A key is "covered"
    // if parsing an empty environment succeeds for it on its own (i.e. it
    // has a Zod `.default()`, unlike `DATABASE_URL`'s bare `z.string().url()`)
    // or if the worker's integration test harnesses set it directly.
    const uncovered = Object.entries(envSchema.shape)
      .filter(([key, schema]) => !HARNESS_INJECTED_KEYS.has(key) && !schema.safeParse(undefined).success)
      .map(([key]) => key);

    // A failure here means a new required env var was added to envSchema
    // with no default and no entry in HARNESS_INJECTED_KEYS above — every
    // worker integration test would start failing on the very first boot,
    // for a reason unrelated to whatever it's actually testing, unless
    // this test catches it first.
    expect(uncovered).toEqual([]);
  });
});

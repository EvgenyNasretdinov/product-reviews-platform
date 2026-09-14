import { describe, expect, it } from 'vitest';
import { APP_ENV } from '../src/config/config.module.js';
import type { AppEnv } from '../src/config/env.js';
import { createTestApp } from './harness.js';

describe('createTestApp env overrides', () => {
  it('does not leak an override into a later call that does not repeat it', async () => {
    const overridden = await createTestApp({ REVIEW_SUBMIT_RATE_LIMIT: '1' });
    try {
      expect(overridden.app.get<AppEnv>(APP_ENV).reviewSubmitRateLimit).toBe(1);
    } finally {
      await overridden.close();
    }

    // No override this time: this call must see the canonical default (5),
    // not the 1 the previous call set on process.env. A regression here
    // would mean every suite after a throttling test silently inherits its
    // tighter limit, order-dependently.
    const defaulted = await createTestApp();
    try {
      expect(defaulted.app.get<AppEnv>(APP_ENV).reviewSubmitRateLimit).toBe(5);
    } finally {
      await defaulted.close();
    }
  });
});

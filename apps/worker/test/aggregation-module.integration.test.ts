import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { AggregationModule } from '../src/aggregation/aggregation.module.js';
import { ConfigModule } from '../src/config/config.module.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Regression guard for a bug review caught in this task: `AggregationModule`
 * used to implement `OnModuleDestroy` and disconnect its own Redis client
 * from it. Nest runs every provider's `onModuleDestroy` before any
 * provider's `onApplicationShutdown` (see `AppModule`'s `PipelineLifecycle`
 * doc comment), so that hook fired *before* the relay had stopped and
 * before either consumer had drained — closing the one dependency the
 * aggregation consumer's cache invalidation needs while a delivery could
 * still be using it.
 *
 * Worse than an ordinary early-close bug: `ioredis` defaults
 * `enableOfflineQueue: true`, so a command issued to an already-disconnected
 * client neither resolves nor rejects — it queues forever. A handler caught
 * in that window would hang, not fail, which is why a test that tries to
 * provoke and catch a rejection would be the wrong shape here (it would
 * hang instead of failing). This asserts the fix directly instead: booting
 * `AggregationModule` on its own and closing it must leave its Redis client
 * exactly as connected as it was before — nothing in this module's own
 * lifecycle may touch it.
 *
 * `redis.status` is checked after a short wait, not immediately after
 * `moduleRef.close()` resolves — confirmed empirically (see this task's own
 * fix report) that `ioredis#disconnect()` does not flip `status` to `'end'`
 * synchronously; it settles a tick or two later. This is not a race between
 * two independent async operations (the flaky shape this file's own doc
 * comment on `stopAndDrain` warns against elsewhere) — it is "wait long
 * enough for a bad disconnect to have happened, then assert it didn't",
 * which only ever produces a false pass if it fires too early, never a
 * false failure. `WAIT_MS` is generously above the ~100ms this settled at
 * in manual testing.
 */
const WAIT_MS = 500;

describe('AggregationModule shutdown', () => {
  let moduleRef: TestingModule | undefined;

  beforeAll(() => {
    process.env.DATABASE_URL = inject('databaseUrl');
    process.env.RABBITMQ_URL = inject('rabbitmqUrl');
    process.env.REDIS_URL = inject('redisUrl');
  });

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
  });

  it('does not disconnect its Redis client when the module itself is torn down', async () => {
    moduleRef = await Test.createTestingModule({ imports: [ConfigModule, AggregationModule] }).compile();
    await moduleRef.init();

    const redis = moduleRef.get(Redis);
    expect(redis.status).toBe('ready');

    await moduleRef.close();
    moduleRef = undefined; // already closed; afterEach's own close() would be a harmless no-op either way

    await sleep(WAIT_MS);

    // If AggregationModule still owned an OnModuleDestroy hook, this would
    // now read 'end' instead — see the module doc comment above for why
    // the wait before this assertion is load-bearing.
    expect(redis.status).toBe('ready');

    redis.disconnect();
  });
});

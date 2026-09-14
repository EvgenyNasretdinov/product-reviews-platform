import { Global, Inject, Logger, Module, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { APP_ENV } from '../../config/config.module.js';
import type { AppEnv } from '../../config/env.js';
import { REDIS_CLIENT } from './redis.constants.js';

/**
 * Wires a single shared ioredis client from the validated `REDIS_URL`.
 *
 * This is deliberately just the connection: no caching helpers live here
 * yet, that arrives with the caching-layer task. Health readiness (Task 5)
 * and later features both depend on this same client existing.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (env: AppEnv): Redis => {
        const client = new Redis(env.redisUrl, {
          // A health check must fail fast rather than hang behind ioredis's
          // default unbounded retry/backoff loop.
          maxRetriesPerRequest: 1,
          lazyConnect: false,
        });
        const logger = new Logger('Redis');
        // ioredis emits 'error' on every failed connection attempt; without
        // a listener Node treats that as an unhandled error and crashes the
        // process. Logging and swallowing it here is what makes a Redis
        // outage a readiness-check failure instead of an API outage.
        client.on('error', (error: Error) => logger.warn(`Redis connection error: ${error.message}`));
        return client;
      },
      inject: [APP_ENV],
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  onModuleDestroy(): void {
    this.client.disconnect();
  }
}

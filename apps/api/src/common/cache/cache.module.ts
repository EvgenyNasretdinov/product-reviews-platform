import { Global, Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { APP_ENV } from '../../config/config.module.js';
import type { AppEnv } from '../../config/env.js';
import { REDIS_CLIENT } from '../redis/redis.constants.js';
import { CacheService } from './cache.service.js';
import { MemoryCacheService } from './memory-cache.service.js';
import { RedisCacheService } from './redis-cache.service.js';

/**
 * Binds the `CacheService` port to a concrete implementation chosen from
 * config: `RedisCacheService` over the shared connection when `REDIS_URL`
 * is configured (every running deployment, since `envSchema` requires it),
 * `MemoryCacheService` otherwise. Every other module injects `CacheService`
 * and never imports either concrete class directly, which is what makes
 * the port a real seam rather than a formality — a suite that wants to
 * skip Redis entirely can override this provider with a fresh
 * `MemoryCacheService` in its own testing module instead.
 */
@Global()
@Module({
  providers: [
    {
      provide: CacheService,
      useFactory: (env: AppEnv, redis: Redis): CacheService =>
        env.redisUrl ? new RedisCacheService(redis) : new MemoryCacheService(),
      inject: [APP_ENV, REDIS_CLIENT],
    },
  ],
  exports: [CacheService],
})
export class CacheModule {}

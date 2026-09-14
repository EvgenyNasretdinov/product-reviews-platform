import { Global, Injectable, Module } from '@nestjs/common';
import { seconds, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import type { Request } from 'express';
import type { Redis } from 'ioredis';
import { APP_ENV } from '../../config/config.module.js';
import type { AppEnv } from '../../config/env.js';
import { REDIS_CLIENT } from '../redis/redis.constants.js';

/**
 * Keys the review-submission rate limit by the authenticated user's id,
 * falling back to the caller's IP when there isn't one.
 *
 * The user-id branch is the case that matters: `POST
 * .../products/:productId/reviews` sits behind the global `JwtAuthGuard`
 * (see AuthModule), which always runs before this guard and populates
 * `req.user`, so every real request through here is authenticated. The IP
 * branch exists only as defence in depth for a future route reachable
 * without authentication — it is not exercised by the endpoint this guard
 * currently protects.
 *
 * Keying by IP alone would let one user behind a shared NAT (an office, a
 * mobile carrier) exhaust the quota of every other user on that same
 * address. Keying by user id alone would leave unauthenticated traffic
 * completely unlimited, which is the wrong default to fail open into on a
 * write endpoint. Falling back from user id to IP, in that order, covers
 * both without either flaw.
 */
@Injectable()
export class ReviewSubmitThrottlerGuard extends ThrottlerGuard {
  protected override getTracker(req: Request): Promise<string> {
    return Promise.resolve(req.user?.id ?? `ip:${req.ip}`);
  }
}

/**
 * Registers `@nestjs/throttler`'s options and storage globally, without
 * installing `ThrottlerGuard` itself as an app-wide `APP_GUARD`. Only the
 * review-submission handler opts in, via `@UseGuards(ReviewSubmitThrottlerGuard)`
 * on that one method (see reviews.controller.ts) — every other route,
 * including the very same controller's own `GET`, never runs this guard at
 * all, so there's nothing for it to skip or ignore there.
 *
 * The limit itself comes from `AppEnv#reviewSubmitRateLimit`
 * (`REVIEW_SUBMIT_RATE_LIMIT`, validated once in config/env.ts), not from
 * a value baked into a `@Throttle()` call site — a decorator is evaluated
 * at class-definition time, before Nest's DI container exists, so it has
 * no way to read a value that only exists after `APP_ENV` is resolved.
 *
 * Storage is `ThrottlerStorageRedisService` wrapping the *same* shared
 * ioredis client `RedisModule` already publishes (`REDIS_CLIENT`), not a
 * second, independently configured connection. This is what makes the
 * counter live in Redis rather than in process memory: an in-memory
 * limiter multiplies the effective limit by the number of running API
 * instances, which turns a control into a comment. Reusing the shared
 * client also means the throttler's keys sit in the exact same keyspace
 * `CacheService#delByPrefix('')` already sweeps on every test's
 * `truncate()` (see test/harness.ts) — so they're flushed between tests
 * the same way every cached DTO is, without needing a second flush path.
 */
@Global()
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [APP_ENV, REDIS_CLIENT],
      useFactory: (env: AppEnv, redis: Redis) => ({
        throttlers: [{ limit: env.reviewSubmitRateLimit, ttl: seconds(3600) }],
        storage: new ThrottlerStorageRedisService(redis),
      }),
    }),
  ],
  providers: [ReviewSubmitThrottlerGuard],
  exports: [ThrottlerModule, ReviewSubmitThrottlerGuard],
})
export class ThrottleModule {}

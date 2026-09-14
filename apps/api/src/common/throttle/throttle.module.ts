import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { seconds, ThrottlerGuard, ThrottlerModule, type ThrottlerStorage } from '@nestjs/throttler';
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
 * Wraps a `ThrottlerStorage` so a Redis failure fails the *rate limit*
 * open rather than failing the *request* closed.
 *
 * `ThrottlerStorageRedisService#increment` has no error handling of its
 * own: a Redis outage surfaces as a rejected promise, which is neither a
 * `Prisma` error nor an `HttpException`, so `PrismaExceptionFilter` would
 * fall through to a bare 500 — review submission would stop working
 * entirely for the duration of the outage.
 *
 * The ruling here is to fail open instead: catch the storage error, log
 * it at `warn` (with the key, so a spike is traceable to this guard
 * rather than a mystery), and answer as if the request were the first
 * one in a fresh window. This mirrors the precedent `RedisCacheService`
 * already set for the cache-aside layer — Redis is an accelerator in this
 * codebase, not a hard dependency, and that principle extends here.
 *
 * The reasoning: moderation, not this limit, is the real control against
 * bad reviews — every submission passes through the moderation queue
 * regardless of whether it was rate-limited on the way in. This limit
 * exists to reduce moderation *load*, not to be the last line of defence
 * against spam. An outage that briefly allows unlimited submissions costs
 * some extra moderator time; an outage that blocks every customer from
 * submitting a review at all costs the feature.
 *
 * Counter-argument, so the trade-off stays visible rather than buried: a
 * deliberate spam wave timed to a Redis outage goes completely
 * unthrottled for as long as the outage lasts. If that risk ever
 * outweighs the cost of blocking genuine submissions during an outage —
 * for example once a WAF or an upstream gateway can absorb this instead —
 * revisit this specific choice rather than assuming it's still right.
 */
// `@nestjs/throttler`'s package root doesn't re-export the
// `ThrottlerStorageRecord` interface itself (only types that reference
// it, like `ThrottlerLimitDetail`), so it's derived here from the one
// method that actually returns it rather than reached via a private
// subpath import into the package's dist layout.
type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

@Injectable()
export class FailOpenThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(FailOpenThrottlerStorage.name);

  constructor(private readonly inner: ThrottlerStorage) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    try {
      return await this.inner.increment(key, ttl, limit, blockDuration, throttlerName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Review-submission rate limiter storage failed for key "${key}"; allowing the request through rather than blocking submissions on a Redis outage: ${message}`);
      return { totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 };
    }
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
 *
 * That Redis storage is wrapped one more time in `FailOpenThrottlerStorage`
 * (see its own doc comment for the full reasoning) so a Redis outage
 * degrades the rate limit, not the endpoint.
 */
@Global()
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [APP_ENV, REDIS_CLIENT],
      useFactory: (env: AppEnv, redis: Redis) => ({
        throttlers: [{ limit: env.reviewSubmitRateLimit, ttl: seconds(3600) }],
        storage: new FailOpenThrottlerStorage(new ThrottlerStorageRedisService(redis)),
      }),
    }),
  ],
  providers: [ReviewSubmitThrottlerGuard],
  exports: [ThrottlerModule, ReviewSubmitThrottlerGuard],
})
export class ThrottleModule {}

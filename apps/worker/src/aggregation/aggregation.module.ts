import { Module } from '@nestjs/common';
import { Redis } from 'ioredis';
import { CacheService } from '../cache/cache.service.js';
import { RedisCacheService } from '../cache/redis-cache.service.js';
import { PrismaModule } from '../common/prisma/prisma.module.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import { APP_ENV } from '../config/config.module.js';
import type { AppEnv } from '../config/env.js';
import { AggregationConsumer } from './aggregation.consumer.js';
import { SummaryRepository } from './summary.repository.js';

/**
 * Wires `AggregationConsumer` for DI. Like `RelayModule` and
 * `ModerationModule` before it, `AggregationConsumer` and
 * `SummaryRepository` are provided through factories rather than plain
 * class DI: `AggregationConsumer`'s constructor takes the bare
 * `PrismaClient` type, not the Nest-specific `PrismaService` subclass, so
 * its own unit and integration tests can construct it directly with plain
 * instances — see `test/aggregation-consumer.integration.test.ts`, which
 * does exactly that instead of going through this module at all.
 *
 * `Redis` (the class itself, from `ioredis`) doubles as the DI token for
 * the client this module owns, the same way `CacheService` doubles as the
 * token for whichever cache implementation is bound to it — an interface
 * has no runtime value to provide against, but a class does.
 *
 * `REDIS_URL` is a required field on `AppEnv` (see `config/env.ts`):
 * `AppModule` wires this module in (Task 6), so every real boot needs it,
 * and `envSchema` is what reports a missing value — at startup, alongside
 * every other configuration problem — rather than this factory finding out
 * on its own. It was optional for one task's duration, with the check
 * living here instead; now that the schema is the real gate, `env.redisUrl`
 * below is trusted rather than re-checked.
 *
 * `Redis` is exported (not just `AggregationConsumer`) so `AppModule`'s
 * `PipelineLifecycle` can close it explicitly, last, alongside the AMQP
 * connection and Prisma. This module does *not* implement `OnModuleDestroy`
 * itself: Nest runs every provider's `onModuleDestroy` before any
 * provider's `onApplicationShutdown` (see `AmqpConnection`'s and
 * `PrismaService`'s doc comments for the same reasoning), so a hook here
 * would disconnect Redis before the relay had stopped or the consumers had
 * drained — and worse than a clean failure, `ioredis`'s default
 * `enableOfflineQueue: true` means a command issued after `.disconnect()`
 * neither resolves nor rejects, it just queues forever. A handler still
 * mid-flight when that happened would hang, not fail, defeating the
 * bounded drain this task exists to guarantee.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    {
      provide: Redis,
      useFactory: (env: AppEnv): Redis => new Redis(env.redisUrl, { maxRetriesPerRequest: 1, lazyConnect: false }),
      inject: [APP_ENV],
    },
    {
      provide: CacheService,
      useFactory: (redis: Redis): CacheService => new RedisCacheService(redis),
      inject: [Redis],
    },
    SummaryRepository,
    {
      provide: AggregationConsumer,
      useFactory: (prisma: PrismaService, summaryRepository: SummaryRepository, cache: CacheService) =>
        new AggregationConsumer(prisma, summaryRepository, cache),
      inject: [PrismaService, SummaryRepository, CacheService],
    },
  ],
  exports: [AggregationConsumer, Redis],
})
export class AggregationModule {}

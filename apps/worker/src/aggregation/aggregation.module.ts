import { Inject, Module, type OnModuleDestroy } from '@nestjs/common';
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
 * `REDIS_URL` is optional on `AppEnv` (see `config/env.ts`) because this
 * module is not yet wired into `AppModule` — registering
 * `AggregationConsumer` onto `TOPOLOGY.queues.aggregation` alongside the
 * relay, the moderation consumer, and graceful shutdown is a later task's
 * job, the same way `RelayModule`'s own doc comment describes for itself.
 * Until then, nothing constructs this module outside of a caller that has
 * already configured Redis, so the factory below throws a clear error
 * rather than silently booting without a cache.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    {
      provide: Redis,
      useFactory: (env: AppEnv): Redis => {
        if (!env.redisUrl) {
          throw new Error('AggregationModule requires REDIS_URL to be configured');
        }
        return new Redis(env.redisUrl, { maxRetriesPerRequest: 1, lazyConnect: false });
      },
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
  exports: [AggregationConsumer],
})
export class AggregationModule implements OnModuleDestroy {
  constructor(@Inject(Redis) private readonly redis: Redis) {}

  onModuleDestroy(): void {
    this.redis.disconnect();
  }
}

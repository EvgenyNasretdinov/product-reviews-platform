import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@reviews/db';
import { APP_ENV } from '../../config/config.module.js';
import type { AppEnv } from '../../config/env.js';

/**
 * The shared Prisma client, wired to the validated `DATABASE_URL` and
 * connected alongside the Nest application lifecycle so a broken
 * connection surfaces at startup rather than on the first query. Mirrors
 * `apps/api/src/common/prisma/prisma.service.ts` for connecting; it
 * deliberately does *not* mirror it for disconnecting.
 *
 * There is no `OnModuleDestroy` here: Nest runs every provider's
 * `onModuleDestroy` before any provider's `onApplicationShutdown` (see
 * `AmqpConnection`'s doc comment for the same reasoning), so a hook here
 * would disconnect Prisma while the moderation or aggregation consumer
 * still had an in-flight handler mid-query — turning a clean shutdown into
 * a failed, dead-lettered delivery on every deploy. `AppModule`'s shutdown
 * orchestrator calls `$disconnect()` explicitly instead, last, once the
 * relay and both consumers have already drained.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  constructor(@Inject(APP_ENV) env: AppEnv) {
    super({ datasources: { db: { url: env.databaseUrl } } });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }
}

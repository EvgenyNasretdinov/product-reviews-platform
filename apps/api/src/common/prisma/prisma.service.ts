import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@reviews/db';
import { APP_ENV } from '../../config/config.module.js';
import type { AppEnv } from '../../config/env.js';

/**
 * The shared Prisma client, wired to the validated `DATABASE_URL` and
 * connected/disconnected alongside the Nest application lifecycle so a
 * broken connection surfaces at startup rather than on the first query.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(APP_ENV) env: AppEnv) {
    super({ datasources: { db: { url: env.databaseUrl } } });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

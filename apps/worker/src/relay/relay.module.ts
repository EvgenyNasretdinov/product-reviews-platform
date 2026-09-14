import { Module } from '@nestjs/common';
import { APP_ENV } from '../config/config.module.js';
import type { AppEnv } from '../config/env.js';
import { PrismaModule } from '../common/prisma/prisma.module.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import { MessagingModule } from '../messaging/messaging.module.js';
import { EventPublisher } from '../messaging/event.publisher.js';
import { OutboxRelayService, type OutboxRelayConfig } from './outbox-relay.service.js';
import { OutboxRepository } from './outbox.repository.js';

/** DI token for the {@link OutboxRelayConfig} derived from `APP_ENV`. */
export const OUTBOX_RELAY_CONFIG = Symbol('OUTBOX_RELAY_CONFIG');

/**
 * Wires the outbox relay for the real app: `OutboxRelayService` is
 * provided through a factory (not plain class DI) because its
 * constructor takes the bare `PrismaClient`/`EventPublisher` types, not
 * their Nest-specific subclasses (`PrismaService`, and `AmqpConnection`
 * one layer further down) — the same shape `MessagingModule` already
 * uses for `EventPublisher` itself, so the relay's own unit and
 * integration tests can construct it directly with plain instances,
 * with no Nest test module required.
 */
@Module({
  imports: [PrismaModule, MessagingModule],
  providers: [
    { provide: OutboxRepository, useFactory: (prisma: PrismaService) => new OutboxRepository(prisma), inject: [PrismaService] },
    {
      provide: OUTBOX_RELAY_CONFIG,
      useFactory: (env: AppEnv): OutboxRelayConfig => ({
        batchSize: env.outboxBatchSize,
        maxAttempts: env.outboxMaxAttempts,
        pollIntervalMs: env.outboxPollIntervalMs,
      }),
      inject: [APP_ENV],
    },
    {
      provide: OutboxRelayService,
      useFactory: (
        prisma: PrismaService,
        publisher: EventPublisher,
        repository: OutboxRepository,
        config: OutboxRelayConfig,
      ) => new OutboxRelayService(prisma, publisher, repository, config),
      inject: [PrismaService, EventPublisher, OutboxRepository, OUTBOX_RELAY_CONFIG],
    },
  ],
  exports: [OutboxRelayService],
})
export class RelayModule {}

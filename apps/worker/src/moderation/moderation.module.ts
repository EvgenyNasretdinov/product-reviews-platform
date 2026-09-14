import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import { ModerationConsumer } from './moderation.consumer.js';
import { ModerationRepository } from './moderation.repository.js';
import { defaultPolicy } from './policy.js';

/**
 * Wires `ModerationConsumer` for DI. Like `RelayModule` and `EventPublisher`
 * before it, `ModerationRepository` is provided through a factory rather
 * than plain class DI: its constructor takes the bare `PrismaClient` and
 * `ModerationPolicy` types, not Nest-specific subclasses, so its own unit
 * and integration tests can construct it directly with plain instances.
 *
 * Registering `ModerationConsumer` on `TOPOLOGY.queues.moderation` through
 * `registerConsumer` is deliberately not done here — that needs the live
 * AMQP channel from `MessagingModule`'s `AmqpConnection`, and wiring every
 * consumer to its queue alongside the relay and graceful shutdown is
 * `AppModule`'s job (a later task), not this module's.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    {
      provide: ModerationRepository,
      useFactory: (prisma: PrismaService) => new ModerationRepository(prisma, defaultPolicy),
      inject: [PrismaService],
    },
    ModerationConsumer,
  ],
  exports: [ModerationConsumer],
})
export class ModerationModule {}

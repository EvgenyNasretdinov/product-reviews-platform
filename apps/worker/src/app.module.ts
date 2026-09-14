import { Injectable, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { AggregationConsumer, type AggregationEvent } from './aggregation/aggregation.consumer.js';
import { AggregationModule } from './aggregation/aggregation.module.js';
import { PrismaService } from './common/prisma/prisma.service.js';
import { ConfigModule } from './config/config.module.js';
import { registerConsumer, type ConsumerHandle } from './messaging/consumer.base.js';
import { AmqpConnection } from './messaging/amqp.connection.js';
import { MessagingModule } from './messaging/messaging.module.js';
import { TOPOLOGY } from './messaging/topology.js';
import { ModerationConsumer, type ReviewSubmittedEvent } from './moderation/moderation.consumer.js';
import { ModerationModule } from './moderation/moderation.module.js';
import { logger } from './observability/logger.js';
import { OutboxRelayService } from './relay/outbox-relay.service.js';
import { RelayModule } from './relay/relay.module.js';

/**
 * How long {@link PipelineLifecycle.onApplicationShutdown} waits for
 * in-flight consumer deliveries to finish after cancelling both consumers,
 * before giving up and closing the connection anyway. Bounded rather than
 * unbounded: a handler stuck forever (a hung query, a hung Redis call with
 * no timeout of its own) must not turn a routine `SIGTERM` into a process
 * that never exits — the orchestrator that sent the signal has its own
 * patience, usually seconds, not an unbounded wait.
 */
const DRAIN_TIMEOUT_MS = 10_000;
const DRAIN_POLL_INTERVAL_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Boots the pipeline once `AmqpConnection` has a live channel (Nest's
 * `onApplicationBootstrap` phase runs after every module's own
 * `onModuleInit`, so the channel is guaranteed to exist here — see
 * `AmqpConnection.onModuleInit`), and owns the one deliberate shutdown
 * sequence Task 6 exists to get right:
 *
 *   1. stop the outbox relay's poll loop and wait for any batch already
 *      in flight to finish (`OutboxRelayService.stopAndDrain`);
 *   2. cancel both consumers at the broker, so no *new* delivery arrives;
 *   3. wait, bounded by {@link DRAIN_TIMEOUT_MS}, for whatever delivery
 *      was already dispatched to each consumer to finish;
 *   4. only then close the channel and the connection;
 *   5. and only then disconnect Prisma.
 *
 * This has to be one hook on one provider, not left to Nest's own
 * `OnModuleDestroy`/`OnApplicationShutdown` phases spread across
 * `AmqpConnection`, `OutboxRelayService`, and `PrismaService`
 * individually: Nest runs every provider's `onModuleDestroy` before any
 * provider's `onApplicationShutdown`, and *within* a phase the order
 * across independent providers depends on module-graph distance, not on
 * anything this pipeline can rely on. Getting the channel closed before
 * the relay had stopped (or before a consumer had drained) would nack
 * whatever was in flight and produce exactly the avoidable dead letters
 * on every deploy this task exists to prevent — see `AmqpConnection` and
 * `PrismaService`'s own doc comments for the same reasoning from their
 * side. Consolidating the whole sequence into this one hook is what makes
 * the order a guarantee instead of an accident of instantiation order.
 */
@Injectable()
class PipelineLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  private moderationHandle: ConsumerHandle | undefined;
  private aggregationHandle: ConsumerHandle | undefined;

  constructor(
    private readonly amqp: AmqpConnection,
    private readonly relay: OutboxRelayService,
    private readonly moderationConsumer: ModerationConsumer,
    private readonly aggregationConsumer: AggregationConsumer,
    private readonly prisma: PrismaService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const channel = this.amqp.getChannel();

    this.moderationHandle = await registerConsumer<ReviewSubmittedEvent>(
      channel,
      TOPOLOGY.queues.moderation.name,
      (event) => this.moderationConsumer.handle(event),
    );
    this.aggregationHandle = await registerConsumer<AggregationEvent>(
      channel,
      TOPOLOGY.queues.aggregation.name,
      (event) => this.aggregationConsumer.handle(event),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    // 1. The relay first: stop claiming new outbox rows, and wait for a
    // batch already mid-transaction to actually finish rather than just
    // asking it to stop.
    await this.relay.stopAndDrain();

    // 2. Stop new deliveries from reaching either consumer. Whatever was
    // already dispatched keeps running — cancel() only affects the
    // broker's willingness to send more.
    await Promise.all([this.moderationHandle?.cancel(), this.aggregationHandle?.cancel()]);

    // 3. Give whatever was already in flight a bounded window to finish
    // on its own, so it can ack (or nack) normally instead of the
    // connection vanishing underneath it.
    await this.drainConsumers();

    // 4. Only now close the channel and the connection.
    await this.amqp.close();

    // 5. And only now disconnect Prisma — the consumers drained in step 3
    // may still have been querying it.
    await this.prisma.$disconnect();
  }

  private async drainConsumers(): Promise<void> {
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const inFlight = (this.moderationHandle?.inFlightCount() ?? 0) + (this.aggregationHandle?.inFlightCount() ?? 0);
      if (inFlight === 0) return;
      await sleep(DRAIN_POLL_INTERVAL_MS);
    }

    const inFlight = (this.moderationHandle?.inFlightCount() ?? 0) + (this.aggregationHandle?.inFlightCount() ?? 0);
    if (inFlight > 0) {
      logger.warn(
        { inFlight },
        `pipeline shutdown: drain timed out after ${DRAIN_TIMEOUT_MS}ms with ${inFlight} handler(s) still running`,
      );
    }
  }
}

/**
 * The worker's full module graph: `ConfigModule` and `MessagingModule`
 * (Task 1) plus the three pieces every earlier task built but deliberately
 * left unwired — `RelayModule` (Task 2), `ModerationModule` (Task 4), and
 * `AggregationModule` (Task 5). `PipelineLifecycle` is what actually
 * subscribes `ModerationConsumer` and `AggregationConsumer` to their
 * queues (through `registerConsumer`) and owns graceful shutdown; see its
 * own doc comment for why that has to be one provider instead of split
 * across the modules below.
 */
@Module({
  imports: [ConfigModule, MessagingModule, RelayModule, ModerationModule, AggregationModule],
  providers: [PipelineLifecycle],
})
export class AppModule {}

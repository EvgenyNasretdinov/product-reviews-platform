import type { EventEnvelope } from '@reviews/contracts';
import { Injectable } from '@nestjs/common';
import type { ConfirmChannel } from 'amqplib';
import { TOPOLOGY } from './topology.js';

/**
 * The full envelope shape this worker publishes — re-exported from
 * `@reviews/contracts`, where it is derived from `eventPayloadSchemas`
 * (one member per event type) rather than hand-written here as a union.
 * Kept re-exported from this module, rather than switching every call
 * site to import it from `@reviews/contracts` directly, so `EventPublisher`
 * and everything downstream of it (the relay, both consumers, the test
 * harness) keep one stable import path for "the envelope type the
 * messaging layer works with".
 *
 * Note this type is *not* a compile-time guarantee that a given
 * envelope's `payload` matches its own `eventType` — nothing in this
 * codebase narrows `EventEnvelope` by `eventType` at the type level (there
 * is no discriminant field), so every place that needs one specific
 * variant (`parseEnvelope` in both the relay and `messaging/consumer.base.ts`)
 * gets there with an `as EventEnvelope` cast after a runtime Zod parse,
 * not a type guard. The parse is what actually enforces the shape; this
 * type only describes it.
 */
export type { EventEnvelope };

/**
 * A source of the current live confirm channel. `AmqpConnection` satisfies
 * this structurally; a test can supply anything with a `getChannel`
 * method (see `apps/worker/test/harness.ts`) without needing a real Nest
 * `AmqpConnection` instance, and `EventPublisher` never caches a channel
 * reference of its own that a reconnect could make stale.
 */
export interface ConfirmChannelSource {
  getChannel(): ConfirmChannel;
}

/**
 * Publishes domain event envelopes to `TOPOLOGY.exchange`, routed by
 * `envelope.eventType`.
 *
 * `publish` resolves only once the broker has confirmed the message —
 * never fire-and-forget. Publishing without waiting for the confirm would
 * let a caller (the outbox relay, Task 2) mark a row published that the
 * broker never actually accepted: exactly the dual-write hazard the
 * outbox pattern exists to remove, reintroduced one layer up between this
 * process and the broker. `channel.publish`'s callback form (rather than
 * `waitForConfirms`, which flushes the whole channel) is wrapped in a
 * promise so each `publish` call awaits only its own confirm.
 */
@Injectable()
export class EventPublisher {
  constructor(private readonly channelSource: ConfirmChannelSource) {}

  publish(envelope: EventEnvelope): Promise<void> {
    const channel = this.channelSource.getChannel();
    const content = Buffer.from(JSON.stringify(envelope));

    return new Promise<void>((resolve, reject) => {
      channel.publish(
        TOPOLOGY.exchange,
        envelope.eventType,
        content,
        {
          persistent: true,
          messageId: envelope.eventId,
          contentType: 'application/json',
        },
        (err: unknown) => {
          if (err) {
            reject(err instanceof Error ? err : new Error('AMQP publish was not confirmed', { cause: err }));
            return;
          }
          resolve();
        },
      );
    });
  }
}

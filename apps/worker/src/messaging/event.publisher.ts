import {
  eventEnvelopeSchema,
  reviewModeratedPayloadSchema,
  reviewSubmittedPayloadSchema,
  reviewUnpublishedPayloadSchema,
} from '@reviews/contracts';
import { Injectable } from '@nestjs/common';
import type { ConfirmChannel } from 'amqplib';
import type { z } from 'zod';
import { TOPOLOGY } from './topology.js';

/**
 * The full envelope shape this worker publishes — the union of the three
 * envelope shapes `@reviews/contracts` defines (one per payload schema),
 * not a separate hand-rolled type: this way an envelope whose payload
 * doesn't match its own `eventType` is a compile error here too, not just
 * a runtime one inside `writeOutboxEvent`.
 */
export type EventEnvelope =
  | z.infer<ReturnType<typeof eventEnvelopeSchema<typeof reviewSubmittedPayloadSchema>>>
  | z.infer<ReturnType<typeof eventEnvelopeSchema<typeof reviewModeratedPayloadSchema>>>
  | z.infer<ReturnType<typeof eventEnvelopeSchema<typeof reviewUnpublishedPayloadSchema>>>;

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

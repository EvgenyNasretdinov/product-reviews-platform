import { EVENT_TYPES, type EventType } from '@reviews/contracts';
import type { ConfirmChannel } from 'amqplib';

interface QueueDefinition {
  name: string;
  bindings: readonly EventType[];
}

/**
 * The broker topology this worker depends on, declared once here and
 * asserted idempotently by {@link assertTopology} on every boot.
 *
 * Each queue's `bindings` is typed as `readonly EventType[]` — not
 * `readonly string[]` — specifically so a typo in a routing key is a
 * TypeScript error, not just something `topology.test.ts`'s "only binds
 * routing keys that are real event types" case would eventually catch.
 * A typo here produces a queue that silently receives nothing: nothing at
 * runtime reports it, reviews simply never get moderated.
 */
export const TOPOLOGY = {
  exchange: 'reviews.events',
  deadLetterExchange: 'reviews.dlx',
  queues: {
    moderation: {
      name: 'moderation.review-submitted',
      bindings: [EVENT_TYPES.REVIEW_SUBMITTED],
    },
    aggregation: {
      name: 'aggregation.review-visibility',
      bindings: [EVENT_TYPES.REVIEW_APPROVED, EVENT_TYPES.REVIEW_UNPUBLISHED],
    },
  },
} as const satisfies {
  exchange: string;
  deadLetterExchange: string;
  queues: Record<string, QueueDefinition>;
};

/** The dead-letter queue name for a given (live) queue name. */
export function dlqName(queue: string): string {
  return `${queue}.dlq`;
}

/**
 * Declares the exchange, dead-letter exchange, every queue, every
 * dead-letter queue, and every binding this worker depends on.
 *
 * Safe to call on every boot: `assertExchange`/`assertQueue`/`bindQueue`
 * are all no-ops when called again with the exact arguments already in
 * effect, which is what this function always passes — a fresh environment
 * needs no manual broker setup, and a redeploy cannot drift from the
 * topology declared here.
 *
 * Each live queue is wired to `deadLetterExchange` with a
 * `deadLetterRoutingKey` equal to the queue's own name, and its
 * dead-letter queue is bound to `deadLetterExchange` under that same
 * routing key — so a message the exchange (a `direct` exchange, since
 * each routing key here identifies exactly one queue) dead-letters from
 * `moderation.review-submitted` lands in `moderation.review-submitted.dlq`
 * and nowhere else, even though both queues' dead letters flow through the
 * one shared exchange.
 */
export async function assertTopology(channel: ConfirmChannel): Promise<void> {
  await channel.assertExchange(TOPOLOGY.exchange, 'topic', { durable: true });
  await channel.assertExchange(TOPOLOGY.deadLetterExchange, 'direct', { durable: true });

  for (const queue of Object.values(TOPOLOGY.queues)) {
    const dlq = dlqName(queue.name);
    await channel.assertQueue(dlq, { durable: true });
    await channel.bindQueue(dlq, TOPOLOGY.deadLetterExchange, queue.name);

    await channel.assertQueue(queue.name, {
      durable: true,
      deadLetterExchange: TOPOLOGY.deadLetterExchange,
      deadLetterRoutingKey: queue.name,
    });

    for (const binding of queue.bindings) {
      await channel.bindQueue(queue.name, TOPOLOGY.exchange, binding);
    }
  }
}

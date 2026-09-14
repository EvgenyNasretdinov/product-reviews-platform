import { eventEnvelopeSchema, eventPayloadSchemas, eventTypeSchema } from '@reviews/contracts';
import { Logger } from '@nestjs/common';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import type { EventEnvelope } from './event.publisher.js';

/** How many unacknowledged deliveries the broker may have in flight per consumer at once. */
const PREFETCH = 10;

const logger = new Logger('registerConsumer');

/** Renders an unknown rejection reason as a log-safe string without risking `[object Object]` from a bare `String(value)`. */
function describeError(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return 'unserializable error value';
  }
}

/**
 * Parses a raw message body into an {@link EventEnvelope}, selecting the
 * payload schema that matches the envelope's own declared `eventType`
 * rather than one fixed schema — the same message body might legitimately
 * be any of the types bound to the queue it arrived on. Throws (never
 * returns a partial result) on anything that doesn't parse: an unparseable
 * JSON body, an unrecognised or missing `eventType`, or a payload that
 * fails the schema for the type it claims to be.
 */
function parseEnvelope(raw: Buffer): EventEnvelope {
  const value = JSON.parse(raw.toString()) as unknown;
  const candidate = value as { eventType?: unknown } | null;
  const typeResult = eventTypeSchema.safeParse(candidate?.eventType);
  if (!typeResult.success) {
    throw new Error('message has no recognised eventType');
  }

  const schema = eventPayloadSchemas[typeResult.data];
  const parsed = eventEnvelopeSchema(schema).safeParse(value);
  if (!parsed.success) {
    throw new Error(`message failed validation for eventType "${typeResult.data}": ${parsed.error.message}`);
  }

  return parsed.data;
}

/**
 * Subscribes `handler` to `queue`, parsing each delivery into an
 * {@link EventEnvelope} before handing it over. Both failure modes end the
 * same way — `channel.nack(msg, false, false)`, which (given `assertTopology`
 * wired every queue's `deadLetterExchange`) dead-letters the message rather
 * than requeueing it:
 *
 * - the body doesn't parse into a valid envelope for its own `eventType`
 *   (malformed, or produced by a version of this system that no longer
 *   agrees with `@reviews/contracts`) — this can never become well-formed
 *   on a later attempt, so requeueing it would only starve the queue behind
 *   it forever;
 * - `handler` itself throws — a transient failure (a dead database
 *   connection, say) looks identical to a permanent one from here, and this
 *   function has no way to tell them apart. Task 4's moderation consumer
 *   and Task 5's aggregation consumer are both designed to be safe to
 *   re-deliver from the DLQ (or a fresh publish) once the underlying
 *   problem is fixed, which is what makes dead-lettering rather than
 *   requeue-forever the right default here too.
 *
 * A successfully handled message is acked, never before `handler` resolves.
 * `channel.prefetch(10)` bounds how many unacked deliveries this consumer
 * can have outstanding at once, so a slow handler can't have the broker
 * hand it its entire backlog before any of it is acknowledged.
 */
export async function registerConsumer<E extends EventEnvelope = EventEnvelope>(
  channel: ConfirmChannel,
  queue: string,
  handler: (event: E) => Promise<void>,
): Promise<void> {
  await channel.prefetch(PREFETCH);

  await channel.consume(queue, (msg: ConsumeMessage | null) => {
    if (!msg) return;
    void handleDelivery(channel, queue, msg, handler);
  });
}

async function handleDelivery<E extends EventEnvelope>(
  channel: ConfirmChannel,
  queue: string,
  msg: ConsumeMessage,
  handler: (event: E) => Promise<void>,
): Promise<void> {
  let envelope: EventEnvelope;
  try {
    envelope = parseEnvelope(msg.content);
  } catch (error) {
    logger.warn(`dead-lettering a message on queue "${queue}" that failed to parse: ${describeError(error)}`);
    channel.nack(msg, false, false);
    return;
  }

  try {
    await handler(envelope as E);
    channel.ack(msg);
    logger.log(`processed event ${envelope.eventId} (${envelope.eventType}) from queue "${queue}"`);
  } catch (error) {
    logger.error(
      `dead-lettering event ${envelope.eventId} (${envelope.eventType}) from queue "${queue}" after handler failure: ${describeError(error)}`,
    );
    channel.nack(msg, false, false);
  }
}

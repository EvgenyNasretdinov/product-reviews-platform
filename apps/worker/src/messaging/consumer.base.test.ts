import { randomUUID } from 'node:crypto';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerConsumer } from './consumer.base.js';

/**
 * A schema-valid `review.submitted` envelope body — `handleDelivery` must
 * get past `parseEnvelope` and into the ack path for this suite's tests
 * to exercise what they're actually about (ack/nack failing on a closed
 * channel), not a parse failure taking the nack branch instead.
 */
function makeValidDelivery(): ConsumeMessage {
  const envelope = {
    eventId: randomUUID(),
    eventType: 'review.submitted',
    version: 1,
    occurredAt: new Date().toISOString(),
    aggregateType: 'review',
    aggregateId: randomUUID(),
    payload: {
      reviewId: randomUUID(),
      productId: randomUUID(),
      authorId: randomUUID(),
      rating: 5,
      title: 'Great product',
      body: 'Solid build quality and easy to use every day.',
      verifiedPurchase: true,
    },
  };
  return { content: Buffer.from(JSON.stringify(envelope)), fields: {}, properties: {} } as unknown as ConsumeMessage;
}

/**
 * A fake `ConfirmChannel` whose `ack`/`nack` throw synchronously — the
 * shape amqplib@2.0.1 actually produces once a channel is closed
 * (`sendImmediately` is replaced by `invalidOp`, which throws
 * `IllegalOperationError` rather than rejecting). `deliver` lets a test
 * push a message into the consumer callback `registerConsumer` installed.
 */
function makeClosedChannel(): { channel: ConfirmChannel; deliver: (msg: ConsumeMessage) => void; ack: ReturnType<typeof vi.fn>; nack: ReturnType<typeof vi.fn> } {
  let onMessage: ((msg: ConsumeMessage | null) => void) | undefined;
  const ack = vi.fn().mockImplementation(() => {
    throw new Error('IllegalOperationError: channel closed');
  });
  const nack = vi.fn().mockImplementation(() => {
    throw new Error('IllegalOperationError: channel closed');
  });
  const channel = {
    prefetch: vi.fn().mockResolvedValue(undefined),
    consume: vi.fn().mockImplementation((_queue: string, handler: (msg: ConsumeMessage | null) => void) => {
      onMessage = handler;
      return Promise.resolve({ consumerTag: 'test-consumer-tag' });
    }),
    cancel: vi.fn().mockResolvedValue(undefined),
    ack,
    nack,
  } as unknown as ConfirmChannel;

  return {
    channel,
    deliver: (msg) => onMessage?.(msg),
    ack,
    nack,
  };
}

/** Waits for every microtask (and one macrotask) queued so far to drain — enough for `handleDelivery`'s promise chain to settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('registerConsumer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not crash the process when ack throws on an already-closed channel', async () => {
    const { channel, deliver, ack } = makeClosedChannel();

    let unhandled: unknown;
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled = reason;
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const handle = await registerConsumer(channel, 'test-queue', async () => {
        // handler succeeds — it's the ack that follows which throws.
      });

      deliver(makeValidDelivery());
      await flush();

      expect(unhandled).toBeUndefined();
      expect(ack).toHaveBeenCalledTimes(1);
      expect(handle.inFlightCount()).toBe(0);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('does not crash the process when nack throws on an already-closed channel after a handler failure', async () => {
    const { channel, deliver, nack } = makeClosedChannel();

    let unhandled: unknown;
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled = reason;
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const handle = await registerConsumer(channel, 'test-queue', () => {
        throw new Error('handler blew up');
      });

      deliver(makeValidDelivery());
      await flush();

      expect(unhandled).toBeUndefined();
      expect(nack).toHaveBeenCalledTimes(1);
      expect(handle.inFlightCount()).toBe(0);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});

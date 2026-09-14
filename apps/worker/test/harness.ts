import { createPrismaClient, type PrismaClient } from '@reviews/db';
import amqplib, { type ChannelModel, type ConfirmChannel, type ConsumeMessage } from 'amqplib';
import { inject } from 'vitest';
import { EventPublisher, type EventEnvelope } from '../src/messaging/event.publisher.js';
import { assertTopology, dlqName, TOPOLOGY } from '../src/messaging/topology.js';

export interface WorkerHarness {
  readonly prisma: PrismaClient;
  readonly channel: ConfirmChannel;
  publish(envelope: EventEnvelope): Promise<void>;
  /** Resolves with the next message delivered to `queue`, acking it, or rejects after `timeoutMs`. */
  consumeOne(queue: string, timeoutMs: number): Promise<ConsumeMessage>;
  /** Empties every declared queue and dead-letter queue. Call between tests. */
  purgeAll(): Promise<void>;
  close(): Promise<void>;
}

const ALL_QUEUES = Object.values(TOPOLOGY.queues).flatMap((queue) => [queue.name, dlqName(queue.name)]);

/**
 * Builds a worker test harness backed by the Postgres and RabbitMQ
 * containers started once per worker in global-setup.ts. Opens its own
 * connection and confirm channel (topology already asserted here, so
 * `consumeOne`/`purgeAll` have something to act on immediately) and wires
 * `publish` through the real {@link EventPublisher}, so the publisher
 * integration tests exercise the exact class the app ships, not a
 * re-implementation of it.
 */
export async function createWorkerHarness(): Promise<WorkerHarness> {
  const prisma = createPrismaClient(inject('databaseUrl'));
  const connectionModel: ChannelModel = await amqplib.connect(inject('rabbitmqUrl'));
  const channel = await connectionModel.createConfirmChannel();
  await assertTopology(channel);

  const publisher = new EventPublisher({ getChannel: () => channel });

  return {
    prisma,
    channel,
    publish: (envelope) => publisher.publish(envelope),
    consumeOne: (queue, timeoutMs) => consumeOne(channel, queue, timeoutMs),
    async purgeAll() {
      for (const queue of ALL_QUEUES) await channel.purgeQueue(queue);
    },
    async close() {
      await channel.close();
      await connectionModel.close();
      await prisma.$disconnect();
    },
  };
}

function consumeOne(channel: ConfirmChannel, queue: string, timeoutMs: number): Promise<ConsumeMessage> {
  return new Promise<ConsumeMessage>((resolve, reject) => {
    let settled = false;
    let consumerTag: string | undefined;

    const finish = (run: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (consumerTag) channel.cancel(consumerTag).catch(() => undefined);
      run();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`consumeOne timeout: no message on queue "${queue}" within ${timeoutMs}ms`)));
    }, timeoutMs);

    channel
      .consume(queue, (msg) => {
        if (!msg) return;
        channel.ack(msg);
        finish(() => resolve(msg));
      })
      .then((ok) => {
        consumerTag = ok.consumerTag;
        // The timeout can fire before this promise resolves (a very short
        // timeoutMs); cancel immediately once we finally have a tag.
        if (settled) channel.cancel(consumerTag).catch(() => undefined);
      })
      .catch((error: unknown) => {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      });
  });
}

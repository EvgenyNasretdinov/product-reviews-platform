import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { AmqpConnection } from '../src/messaging/amqp.connection.js';
import { TOPOLOGY } from '../src/messaging/topology.js';

/**
 * Everything else in this suite bypasses `AppModule`/`AmqpConnection`
 * entirely: `test/harness.ts` opens its own raw `amqplib` connection and
 * hands `EventPublisher` a bare `{ getChannel }` stub, so a bug in
 * `AmqpConnection.connect()`, `onModuleDestroy()`, or the real DI wiring
 * between `ConfigModule` and `MessagingModule` would pass every other
 * test in this package while the worker still couldn't boot. Plan 1 had
 * exactly this shape of gap — a circular import that broke every boot
 * survived typecheck and the whole per-module suite, caught only once a
 * later task assembled the full dependency graph. This test assembles
 * that graph now, against the real container, instead of waiting for
 * Task 6 to be the first to do it.
 */
describe('worker boot', () => {
  let moduleRef: TestingModule;

  beforeAll(() => {
    process.env.RABBITMQ_URL = inject('rabbitmqUrl');
    // Task 2 (the outbox relay) makes DATABASE_URL a required part of the
    // worker's env; AppModule's ConfigModule validates it on every boot
    // regardless of whether RelayModule is wired into the graph yet.
    process.env.DATABASE_URL = inject('databaseUrl');
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  it('boots the real module graph and connects to RabbitMQ with topology already asserted', async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    // TestingModule has no HTTP server to start; `init()` is what runs
    // every module's onModuleInit (AmqpConnection's real connect) here.
    await moduleRef.init();

    const amqp = moduleRef.get(AmqpConnection);
    const channel = amqp.getChannel();

    // checkQueue only succeeds against a queue that already exists — proof
    // that assertTopology ran as part of this boot, not just that some
    // channel exists.
    await expect(channel.checkQueue(TOPOLOGY.queues.moderation.name)).resolves.toBeDefined();
    await expect(channel.checkQueue(TOPOLOGY.queues.aggregation.name)).resolves.toBeDefined();
  });
});

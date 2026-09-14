import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

/**
 * This worker has no HTTP surface — it relays outbox events to RabbitMQ
 * and consumes them for moderation and rating aggregation — so it boots a
 * bare application context rather than an HTTP server. `enableShutdownHooks`
 * wires `SIGTERM`/`SIGINT` to Nest's own `close()`, which is what runs
 * `AppModule`'s `PipelineLifecycle.onApplicationShutdown` — the ordered
 * stop-relay, cancel-consumers, drain, then close-channel-and-Prisma
 * sequence documented on that class — instead of dropping in-flight work
 * on every deploy.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
}

void main();

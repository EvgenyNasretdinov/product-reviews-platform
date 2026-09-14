import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

/**
 * This worker has no HTTP surface — it relays outbox events to RabbitMQ
 * and consumes them for moderation and rating aggregation — so it boots a
 * bare application context rather than an HTTP server. `enableShutdownHooks`
 * wires `SIGTERM`/`SIGINT` to each module's `onModuleDestroy`, which is
 * what lets `AmqpConnection` close its channel and connection cleanly
 * instead of dropping in-flight work on every deploy.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
}

void main();

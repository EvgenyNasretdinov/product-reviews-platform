import { Module } from '@nestjs/common';
import { APP_ENV } from '../config/config.module.js';
import type { AppEnv } from '../config/env.js';
import { AmqpConnection } from './amqp.connection.js';
import { EventPublisher } from './event.publisher.js';

@Module({
  providers: [
    {
      provide: AmqpConnection,
      useFactory: (env: AppEnv) => new AmqpConnection(env),
      inject: [APP_ENV],
    },
    {
      provide: EventPublisher,
      useFactory: (amqp: AmqpConnection) => new EventPublisher(amqp),
      inject: [AmqpConnection],
    },
  ],
  exports: [AmqpConnection, EventPublisher],
})
export class MessagingModule {}

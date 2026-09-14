import { Module } from '@nestjs/common';
import { AmqpConnection } from './amqp.connection.js';
import { EventPublisher } from './event.publisher.js';

@Module({
  providers: [
    AmqpConnection,
    {
      provide: EventPublisher,
      useFactory: (amqp: AmqpConnection) => new EventPublisher(amqp),
      inject: [AmqpConnection],
    },
  ],
  exports: [AmqpConnection, EventPublisher],
})
export class MessagingModule {}

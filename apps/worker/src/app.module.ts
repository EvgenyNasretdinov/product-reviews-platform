import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { MessagingModule } from './messaging/messaging.module.js';

@Module({
  imports: [ConfigModule, MessagingModule],
})
export class AppModule {}

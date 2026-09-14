import { Module } from '@nestjs/common';
import { ReviewsModule } from '../reviews/reviews.module.js';
import { ModerationController } from './moderation.controller.js';
import { ModerationService } from './moderation.service.js';

@Module({
  imports: [ReviewsModule],
  controllers: [ModerationController],
  providers: [ModerationService],
})
export class ModerationModule {}

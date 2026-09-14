import { Module } from '@nestjs/common';
import { MyReviewsController, ReviewManagementController, ReviewsController } from './reviews.controller.js';
import { ReviewsRepository } from './reviews.repository.js';
import { ReviewsService } from './reviews.service.js';
import { VotesController } from './votes.controller.js';
import { VotesService } from './votes.service.js';

@Module({
  controllers: [ReviewsController, ReviewManagementController, MyReviewsController, VotesController],
  providers: [ReviewsService, ReviewsRepository, VotesService],
  // Exported so ModerationModule can inject ReviewsRepository directly —
  // the moderation queue and decision endpoint are additional methods on
  // that same repository (see its own doc comment on why atomic writes to
  // `reviews` all live behind that one class), not a second repository
  // duplicating its Prisma access.
  exports: [ReviewsRepository],
})
export class ReviewsModule {}

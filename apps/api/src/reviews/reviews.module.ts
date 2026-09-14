import { Module } from '@nestjs/common';
import { ReviewsController } from './reviews.controller.js';
import { ReviewsRepository } from './reviews.repository.js';
import { ReviewsService } from './reviews.service.js';
import { VotesController } from './votes.controller.js';
import { VotesService } from './votes.service.js';

@Module({
  controllers: [ReviewsController, VotesController],
  providers: [ReviewsService, ReviewsRepository, VotesService],
})
export class ReviewsModule {}

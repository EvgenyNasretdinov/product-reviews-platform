import { eventEnvelopeSchema, reviewSubmittedPayloadSchema } from '@reviews/contracts';
import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { ModerationRepository } from './moderation.repository.js';

/** The full envelope shape a `review.submitted` delivery is parsed into. */
export type ReviewSubmittedEvent = z.infer<ReturnType<typeof eventEnvelopeSchema<typeof reviewSubmittedPayloadSchema>>>;

/**
 * The moderation queue's handler: `registerConsumer` (see
 * `messaging/consumer.base.ts`) hands it a parsed, schema-valid
 * `review.submitted` envelope and expects `handle` to either finish or
 * throw — never to swallow a failure, since a thrown error is what tells
 * `registerConsumer` to dead-letter the delivery instead of acking it.
 *
 * `handle` itself is a thin adapter: only `event.payload.reviewId` is
 * meaningful to {@link ModerationRepository.moderate}, which re-reads the
 * review's current row rather than trusting anything else on the event —
 * see its own doc comment for why.
 */
@Injectable()
export class ModerationConsumer {
  constructor(private readonly repository: ModerationRepository) {}

  async handle(event: ReviewSubmittedEvent): Promise<void> {
    await this.repository.moderate(event.payload.reviewId);
  }
}

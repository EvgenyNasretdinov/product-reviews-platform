import { EVENT_TYPES, type EventType } from '@reviews/contracts';
import { writeOutboxEvent } from '@reviews/db';
import type { PrismaClient } from '@reviews/db';
import { Injectable } from '@nestjs/common';
import type { ModerationPolicy, Verdict } from './policy.types.js';

/** How many of the author's other review bodies the policy sees, when deciding whether this one is a duplicate. */
const PREVIOUS_BODIES_LIMIT = 20;

function eventTypeFor(decision: Verdict['decision']): EventType {
  switch (decision) {
    case 'APPROVED':
      return EVENT_TYPES.REVIEW_APPROVED;
    case 'REJECTED':
      return EVENT_TYPES.REVIEW_REJECTED;
    case 'FLAGGED':
      return EVENT_TYPES.REVIEW_FLAGGED;
  }
}

/**
 * Owns the one transaction that turns a `review.submitted` delivery into a
 * moderation decision: read the review fresh (never trust the event's own
 * snapshot — a redelivery may be stale), classify it, write the decision,
 * and emit the resulting event, all inside one `$transaction` so a crash
 * between the status write and the outbox insert can never happen.
 */
@Injectable()
export class ModerationRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly policy: ModerationPolicy,
  ) {}

  /**
   * Moderates `reviewId`, or does nothing at all.
   *
   * The early return on a missing row or a non-`PENDING` status covers two
   * different races with the same guard: a redelivered `review.submitted`
   * (this handler already decided it once) and a human moderator who
   * reached `POST /moderation/reviews/:id` before this handler's
   * transaction started (the review is `REJECTED`, `FLAGGED`, or already
   * `APPROVED` by the time we look). Both leave the review exactly as it
   * was found.
   *
   * That read-then-check is not by itself race-free against a *concurrent*
   * writer — the `updateMany` below closes that window with the same
   * `status: 'PENDING'` predicate as its `WHERE` clause, so the guard and
   * the write are one atomic statement. If a moderator's decision commits
   * between this method's read and its `updateMany`, the `updateMany`
   * matches zero rows, and this method returns without emitting an event —
   * the moderator's decision wins, not this handler's.
   */
  async moderate(reviewId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const review = await tx.review.findUnique({ where: { id: reviewId } });
      if (!review || review.status !== 'PENDING') return;

      // `orderBy: createdAt desc` is what makes `take: 20` mean the
      // author's twenty *most recent* other reviews rather than whichever
      // twenty Postgres happens to return: for a prolific author, an
      // unordered take could miss their newest bodies entirely, which are
      // exactly what duplicate detection cares about. Served by the
      // `reviews_author_id_created_at_idx` index (see schema.prisma) —
      // without it this scans instead of seeking, on every
      // review.submitted delivery, not only for prolific authors.
      const previous = await tx.review.findMany({
        where: { authorId: review.authorId, id: { not: review.id } },
        select: { body: true },
        orderBy: { createdAt: 'desc' },
        take: PREVIOUS_BODIES_LIMIT,
      });

      const verdict = this.policy.classify({
        title: review.title,
        body: review.body,
        rating: review.rating,
        verifiedPurchase: review.verifiedPurchase,
        authorPreviousBodies: previous.map((p) => p.body),
      });

      const updated = await tx.review.updateMany({
        where: { id: review.id, status: 'PENDING' },
        data: {
          status: verdict.decision,
          moderationReason: verdict.reason,
          publishedAt: verdict.decision === 'APPROVED' ? new Date() : null,
        },
      });
      if (updated.count === 0) return;

      // FLAGGED emits review.flagged and nothing else: the review never
      // became visible, so the rating projection (which only listens for
      // review.approved/review.unpublished — see TOPOLOGY) has nothing to
      // recompute.
      await writeOutboxEvent(tx, {
        eventType: eventTypeFor(verdict.decision),
        aggregateId: review.id,
        payload: {
          reviewId: review.id,
          productId: review.productId,
          status: verdict.decision,
          moderationReason: verdict.reason,
          decidedBy: 'AUTOMATIC',
          moderatorId: null,
        },
      });
    });
  }
}

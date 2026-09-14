import { cacheKeys, eventEnvelopeSchema, reviewModeratedPayloadSchema, reviewUnpublishedPayloadSchema } from '@reviews/contracts';
import { Injectable, Logger } from '@nestjs/common';
import type { PrismaClient } from '@reviews/db';
import type { z } from 'zod';
import { CacheService } from '../cache/cache.service.js';
import { SummaryRepository } from './summary.repository.js';

/**
 * The full envelope shape a `review.approved` or `review.unpublished`
 * delivery is parsed into — the two event types `TOPOLOGY.queues.aggregation`
 * binds (see `messaging/topology.ts`). Both payload shapes carry
 * `productId`, which is all `handle` needs; a `review.flagged` or
 * `review.rejected` event never reaches this handler at all, since neither
 * is bound to the aggregation queue — nothing became visible, so there is
 * nothing for the projection to recompute.
 */
export type AggregationEvent =
  | z.infer<ReturnType<typeof eventEnvelopeSchema<typeof reviewModeratedPayloadSchema>>>
  | z.infer<ReturnType<typeof eventEnvelopeSchema<typeof reviewUnpublishedPayloadSchema>>>;

const logger = new Logger('AggregationConsumer');

/**
 * The aggregation queue's handler: recomputes `product_rating_summary` for
 * the event's product, then invalidates the cache entries the API's
 * cache-aside reads populated from the stale data.
 *
 * The database write and the cache invalidation are deliberately two
 * separate steps, in that order, with a hard boundary between them: the
 * summary recompute runs inside one `$transaction` (so its own read of
 * `products` for the slug and `SummaryRepository.recompute`'s write are
 * consistent with each other), and cache invalidation only ever starts
 * once that transaction has *committed*. Invalidating from inside the
 * transaction would let a reader observe the deleted cache entry before
 * the new row is visible (a `SELECT` from another connection can't see an
 * uncommitted write, but a `DEL` against Redis has no such isolation) —
 * exactly the kind of window a rollback would then leave stale-forever
 * instead of merely stale-until-TTL.
 *
 * Cache invalidation is wrapped in its own try/catch that only logs: a
 * Redis outage must cost freshness up to the cache's TTL, never the
 * ability to record the rating at all. This mirrors the API's own
 * cache-aside read, which degrades to a database read on a cache failure
 * rather than failing the request.
 */
@Injectable()
export class AggregationConsumer {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly summaryRepository: SummaryRepository,
    private readonly cache: CacheService,
  ) {}

  async handle(event: AggregationEvent): Promise<void> {
    const { productId } = event.payload;

    const product = await this.prisma.$transaction(async (tx) => {
      await this.summaryRepository.recompute(tx, productId);
      return tx.product.findUniqueOrThrow({ where: { id: productId }, select: { slug: true } });
    });

    try {
      // `productSummary` has no writer yet anywhere in this codebase — the
      // API's cache-aside read only ever populates `productDetail` and
      // `reviewListFirstPage` today. It is deleted anyway: a legitimate
      // future cache target the design already names a key for, and
      // deleting a key nothing writes is a harmless no-op. The opposite
      // order — shipping the cache write later without this invalidation
      // already in place — is how a cache entry goes stale silently the
      // day something finally does write it.
      await this.cache.del(cacheKeys.productDetail(product.slug), cacheKeys.productSummary(productId));
      await this.cache.delByPrefix(cacheKeys.reviewListPrefix(productId));
    } catch (error) {
      logger.warn(
        `cache invalidation failed for product ${productId} after a rating recompute; ` +
          `stale entries will expire on their own TTL: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

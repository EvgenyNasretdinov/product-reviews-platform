-- Serves ModerationRepository.moderate's "author's previous bodies" query
-- (apps/worker/src/moderation/moderation.repository.ts): a bare authorId
-- equality filter, ordered by created_at descending, bounded by
-- `take: 20`, run on every review.submitted delivery. Neither existing
-- reviews index can serve it -- both are product-led
-- (reviews_product_id_status_created_at_idx,
-- reviews_product_id_status_helpful_count_idx) -- so without this the
-- query falls back to a sequential scan whose cost grows with table size,
-- not with how many reviews the author actually wrote.
CREATE INDEX "reviews_author_id_created_at_idx" ON "reviews"("author_id", "created_at" DESC);

import { Injectable } from '@nestjs/common';
import type { Prisma } from '@reviews/db';

/**
 * Owns the one statement that keeps `product_rating_summary` in sync with
 * `reviews`.
 *
 * `recompute` is a single `INSERT ... SELECT ... ON CONFLICT DO UPDATE`
 * driven by one aggregate query over `reviews WHERE product_id = $1 AND
 * status = 'APPROVED'` — never a read-modify-write that adjusts the
 * existing row by a delta. That is what makes it idempotent by
 * construction: the row this writes is a pure function of the current
 * `reviews` table, so a duplicate delivery of `review.approved` (or any
 * interleaving of retries) writes exactly the same values, and the
 * projection can never drift from the reviews it summarises the way an
 * increment/decrement pair could if one side of a pair were ever lost or
 * double-applied. The cost is a scan of the product's reviews on every
 * delivery rather than an O(1) update; at this system's scale that is the
 * right trade, and is cheap to change later (a materialised delta table,
 * or a partial index) if it stops being one.
 *
 * `coalesce` around `sum`/`avg` is what turns "zero approved reviews
 * matched" into a row of zeros rather than a row of nulls: Postgres still
 * returns exactly one row from an aggregate query with no matching rows
 * (unlike a `GROUP BY` query, which would return none), but every
 * aggregate in it is `NULL` on an empty input. Without `coalesce`,
 * `average_rating` would be written as `NULL` for a product whose last
 * approved review was just unpublished — the catalogue reads this table
 * directly, so a `NULL` average would need to be special-cased by every
 * reader, and a *missing* row would be worse still.
 *
 * Idempotent under *sequential* redelivery is not the same guarantee as
 * correct under *concurrent* delivery, which `PREFETCH = 10`
 * (`consumer.base.ts`) makes routine: two `review.approved` events for the
 * same product, dispatched to two concurrent handler calls, each take
 * their own snapshot of `reviews` before either writes. Postgres does not
 * re-run the `SELECT` after an `ON CONFLICT` conflict recheck, so whichever
 * transaction's `UPDATE` commits second overwrites the row with values
 * computed from *its own* (possibly older) snapshot — not a fresh one —
 * and the projection can end up permanently behind, wrong until some
 * unrelated later event happens to correct it. `pg_advisory_xact_lock`,
 * keyed on `productId` and taken as the first statement below, serialises
 * concurrent `recompute` calls for the *same* product (different products
 * still run fully in parallel — the lock key is per-product, and the lock
 * is released automatically at transaction end): the second call blocks
 * until the first commits, and then takes its snapshot *after* that
 * commit, so it sees the first call's write and recomputes from the true
 * current state rather than a stale one.
 */
@Injectable()
export class SummaryRepository {
  async recompute(tx: Prisma.TransactionClient, productId: string): Promise<void> {
    // Must be the first statement: it serialises everything below against
    // any other `recompute` call for the same product, and does nothing
    // for a call that arrives after this transaction has already
    // committed (or rolled back) and released the lock.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${productId}))`;

    await tx.$executeRaw`
      INSERT INTO product_rating_summary (
        product_id, review_count, rating_sum, average_rating,
        count_1, count_2, count_3, count_4, count_5, updated_at
      )
      SELECT
        ${productId}::uuid,
        count(*),
        coalesce(sum(rating), 0),
        coalesce(round(avg(rating)::numeric, 2), 0),
        count(*) FILTER (WHERE rating = 1),
        count(*) FILTER (WHERE rating = 2),
        count(*) FILTER (WHERE rating = 3),
        count(*) FILTER (WHERE rating = 4),
        count(*) FILTER (WHERE rating = 5),
        now()
      FROM reviews
      WHERE product_id = ${productId}::uuid AND status = 'APPROVED'
      ON CONFLICT (product_id) DO UPDATE SET
        review_count = EXCLUDED.review_count,
        rating_sum = EXCLUDED.rating_sum,
        average_rating = EXCLUDED.average_rating,
        count_1 = EXCLUDED.count_1,
        count_2 = EXCLUDED.count_2,
        count_3 = EXCLUDED.count_3,
        count_4 = EXCLUDED.count_4,
        count_5 = EXCLUDED.count_5,
        updated_at = now()
    `;
  }
}

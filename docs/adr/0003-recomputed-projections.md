# 0003: Recomputed projections over incremental deltas

## Context

`product_rating_summary` (count, sum, average, 1–5 histogram) has to stay
current as reviews are approved and unpublished, driven by events consumed
at least once (ADR 0002). The aggregation consumer needs a strategy for
turning a `review.approved` / `review.unpublished` event into an update to
that row, and the strategy has to survive the same event being delivered
twice.

## Decision

On every relevant event, the consumer **recomputes the whole summary row**
for that product from `reviews WHERE status = 'APPROVED'` in one SQL
statement — count, sum, average, and histogram together — rather than
incrementing or decrementing counters based on the event's payload. The
same approach is used for a review's `helpful_count` /
`not_helpful_count`, recomputed from `review_votes` after every vote.

## Consequences

- **Redelivery is harmless by construction, not by bookkeeping.** A
  duplicate `review.approved` event recomputes the same numbers from the
  same source rows and writes an identical row — there is no counter to
  double-increment and no deduplication table to maintain or get wrong.
- The projection **cannot drift** from its source: `reviews` is always the
  ground truth, and the summary is a function of it, not an independent
  value that accumulates small errors over time from missed or duplicated
  deltas.
- The cost is real: each event triggers a full aggregate scan over that
  product's approved reviews, under a row lock, instead of an O(1)
  increment. At the traffic this system is designed for — a product
  catalogue with dozens to low hundreds of reviews per product — that scan
  is inexpensive and the row lock is uncontended in practice. It stops
  being acceptable once a single product accumulates tens of thousands of
  reviews *and* sees a high concurrent write rate on that same row, at
  which point the lock itself, not just the scan cost, becomes the
  bottleneck.
- The migration path, if that day comes, is incremental deltas guarded by
  an event sequence number (so a delta can detect and skip a redelivery)
  plus a periodic reconciliation job that recomputes from source
  occasionally to catch drift — strictly more machinery than what ships
  today, which is exactly why it is deferred rather than built speculatively.

## Alternatives considered

- **Increment/decrement a counter per event** (`UPDATE ... SET
  review_count = review_count + 1, rating_sum = rating_sum + $rating`).
  Rejected as the default: it is O(1) per event, but every consumer must
  then defend against redelivery inflating the counter, which means either
  a `processed_events` deduplication table (see the design document's
  idempotency section for why that table was deliberately not built) or an
  event sequence number and careful ordering guarantees. That correctness
  burden is exactly the kind of bug that is invisible until a redelivery
  happens in production and the number is quietly wrong.
- **Update the summary in the same transaction as the review**, making it
  strongly consistent instead of eventually consistent. Rejected — this
  serialises every write to a popular product's review through a single
  summary row, and reintroduces the exact synchronous coupling the outbox
  (ADR 0002) exists to avoid.

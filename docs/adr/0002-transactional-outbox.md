# 0002: Transactional outbox over publishing from the request handler

## Context

Submitting, editing, or moderating a review needs to do two things that
must not diverge: change the row's state in Postgres, and notify the rest
of the system (moderation, rating aggregation, cache invalidation) that it
happened. The two live in different systems — Postgres and RabbitMQ — with
no shared transaction between them.

## Decision

`apps/api` never publishes to RabbitMQ from the request handler. Every
state change writes a row to an `outbox` table in the **same database
transaction** as the state change. A separate relay in `apps/worker` polls
`outbox` with `SELECT ... FOR UPDATE SKIP LOCKED`, publishes each
unpublished row to RabbitMQ, and marks it published — outside the original
transaction, after the broker has accepted it.

## Consequences

- A review's state and its event **cannot diverge**: either both the row
  and the outbox entry commit, or neither does. There is no window where
  the review exists but no event will ever announce it, and no window
  where an event fires for a review that the transaction then rolled back.
- This costs a relay process, an `outbox` table, and at-least-once
  delivery that every consumer must tolerate — a message can be published
  and then re-published if the relay dies after the broker acks but before
  `published_at` is written. Consumers are written to be replay-safe by
  construction (conditional updates, recomputed projections — see ADR
  0003) rather than by a deduplication table, which is itself a decision
  worth reading in the design document's idempotency section.
- Delivery latency is bounded by the relay's poll interval
  (`OUTBOX_POLL_INTERVAL_MS`, 500ms by default) rather than being
  immediate. In practice this reads as "under a second," which is why the
  README's walkthrough describes publish latency that way rather than
  promising synchronous delivery.
- A publish failure is distinguished from a handler failure: the relay
  retries a row up to `OUTBOX_MAX_ATTEMPTS` times before parking it
  (excluded from polling, kept for inspection); a consumer that fails to
  *handle* a delivered message nacks it to that queue's dead-letter queue
  instead, visible in the RabbitMQ management UI.

## Alternatives considered

- **Publish directly from the request handler**, after the transaction
  commits. Rejected — this is the classic dual-write problem. If the
  process dies between the commit and the publish, the review exists with
  no one ever told about it: it never gets moderated, never counts toward
  the rating, and the product page silently forgets it. Publishing *before*
  the commit is worse: a rollback leaves an event for a review that never
  existed. Retrying the publish on failure does not fix this, because the
  failure being handled is process death, not just a rejected call.
- **A single message broker as the source of truth** (event-sourced,
  no separate row for current state). Rejected as disproportionate to the
  system's needs — it changes how every read is served, not just how
  writes are announced, for a domain that has no other reason to want
  event sourcing.

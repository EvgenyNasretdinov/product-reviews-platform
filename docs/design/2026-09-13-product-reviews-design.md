# Product Reviews Platform — Design

Date: 2026-09-13
Status: Approved, ready for implementation planning

## 1. Purpose and scope

A product reviews system in the spirit of Amazon or Alza: shoppers browse products,
read reviews, and write their own. Reviews are not published immediately — they pass
through moderation. Aggregate ratings shown next to every product are kept current as
reviews are approved and withdrawn.

In scope:

- Product catalogue with per-product rating summary (average, count, 1–5 histogram)
- Review submission, editing, and deletion by the author
- Asynchronous moderation: automatic classification plus a manual queue with a UI
- Helpfulness votes and review sorting/filtering
- Verified-purchase marking
- Authentication with two roles: customer and moderator
- A web frontend covering all of the above

Out of scope (deliberately): checkout and payments, review images, full-text search,
notifications, internationalisation, multi-tenancy.

## 2. Architecture

Three deployable processes over shared Postgres, Redis, and RabbitMQ:

- **`apps/api`** — NestJS HTTP service. Owns all writes. Never publishes to the broker
  directly; it writes domain events to an outbox table inside the same transaction as
  the state change.
- **`apps/worker`** — NestJS standalone application. Runs the outbox relay and the event
  consumers (moderation, rating aggregation, cache invalidation).
- **`apps/web`** — Next.js (App Router) frontend.

This is a modular monolith deployed as multiple processes, not a microservice system.
The domain is one bounded context; splitting it into independently deployable services
would add network failure modes and deployment ceremony without buying independent
scaling or independent teams. The module boundaries inside the codebase are drawn so
that extracting a service later is a mechanical change, not a rewrite.

### 2.1 Write path

```
POST /reviews
  └─ tx: INSERT reviews(status=PENDING) + INSERT outbox(review.submitted)
                                │
                     outbox relay (SELECT ... FOR UPDATE SKIP LOCKED)
                                │
                        RabbitMQ topic exchange `reviews.events`
                                ├──> moderation consumer
                                │      classify() → UPDATE reviews WHERE status='PENDING'
                                │      + INSERT outbox(review.approved|rejected|flagged)
                                └──> aggregation consumer
                                       recompute product_rating_summary
                                       DEL cache keys for the product
```

The outbox exists to remove the dual-write problem: without it, "commit the review, then
publish to RabbitMQ" loses events whenever the process dies between the two steps, and
"publish, then commit" produces events for reviews that do not exist. With the outbox,
the event and the state change share one transaction, and the relay guarantees
at-least-once delivery.

`FOR UPDATE SKIP LOCKED` lets several relay instances drain the outbox concurrently
without handing the same row to two of them.

Failure is handled differently on either side of the broker, and the two paths should not
be confused. A **publish** failure in the relay increments `outbox.attempts` and records
`last_error`; after 5 attempts the row is parked — excluded from polling, retained for
inspection, and logged at error level. A **handler** failure in a consumer nacks the
message without requeueing it, and the broker routes it to that queue's dead-letter queue,
which is inspectable in the RabbitMQ management UI that `docker compose` brings up.
Requeueing a message that failed on its own content simply starves the queue behind it.

### 2.2 Idempotency

Delivery is at-least-once, so every consumer must tolerate replays. There is deliberately
**no `processed_events` deduplication table**. Idempotency comes from the handlers being
naturally replay-safe:

1. **Review status transitions** are conditional updates — `UPDATE reviews SET status=...
   WHERE id=$1 AND status='PENDING'`. A redelivered event matches zero rows and is
   acknowledged as a no-op.
2. **The rating projection is recomputed, not incremented.** On every relevant event the
   consumer recalculates the whole summary for that product from `reviews WHERE
   status='APPROVED'` in a single statement. Double delivery cannot inflate a counter,
   and the projection cannot drift from its source.

The cost is O(reviews per product) per event instead of O(1). At the traffic this system
is designed for that is irrelevant; a product would need tens of thousands of reviews and
a high write rate before it mattered. The migration path, if that day comes, is
incremental deltas guarded by an event sequence number plus a periodic reconciliation
job — noted here so the next developer does not have to rediscover it.

## 3. Data model

Postgres. Business entities use **UUIDv7** primary keys: they appear in URLs, so they must
not be enumerable, and being time-ordered keeps B-tree insert locality good (unlike v4,
which scatters writes across index pages). Infrastructure tables use
**`BIGINT GENERATED ALWAYS AS IDENTITY`** — the relay depends on a strict monotonic read
order, and a 16-byte key buys nothing there.

`GENERATED ALWAYS AS IDENTITY` is the SQL-standard form and is preferred over the
Postgres-specific `BIGSERIAL`: the sequence is owned by the column rather than being a
separately droppable object with separate grants. `GENERATED ALWAYS` (not `BY DEFAULT`)
also forbids explicit inserts of `id`, which is exactly right for an append-only journal.

Implementation note: Prisma Migrate emits `BIGSERIAL` for `BigInt @id
@default(autoincrement())`. The generated migration SQL will be edited by hand to use an
identity column. Prisma introspects identity columns back as `autoincrement()`, so later
`migrate dev` runs should not report drift — this must be verified in practice during
implementation, and if Prisma disagrees the outcome is recorded in an ADR.

| Table | Columns of note | Constraints and indexes |
|---|---|---|
| `users` | `email`, `display_name`, `password_hash` (argon2id), `role: CUSTOMER \| MODERATOR` | `UNIQUE(email)` |
| `products` | `slug`, `name`, `description`, `image_url`, `price_cents`, `currency` | `UNIQUE(slug)` |
| `purchases` | `user_id`, `product_id`, `purchased_at` | `UNIQUE(user_id, product_id)` — sole purpose is the verified-purchase flag |
| `reviews` | `product_id`, `author_id`, `rating` 1–5, `title`, `body`, `status: PENDING \| APPROVED \| REJECTED \| FLAGGED`, `verified_purchase`, `moderation_reason`, `helpful_count`, `not_helpful_count`, `published_at` | `UNIQUE(product_id, author_id)`; `CHECK(rating BETWEEN 1 AND 5)`; `(product_id, status, created_at DESC)`; `(product_id, status, helpful_count DESC)` |
| `review_votes` | `review_id`, `user_id`, `value: HELPFUL \| NOT_HELPFUL` | `PRIMARY KEY(review_id, user_id)` — a user may change their vote, not stack it |
| `product_rating_summary` | `product_id` PK, `review_count`, `rating_sum`, `average_rating`, `count_1`..`count_5`, `updated_at` | materialised projection, one row per product |
| `outbox` | `id BIGINT IDENTITY`, `aggregate_type`, `aggregate_id`, `event_type`, `payload jsonb`, `occurred_at`, `published_at`, `attempts` | partial index on `(id) WHERE published_at IS NULL` |

`UNIQUE(product_id, author_id)` enforces "one review per user per product" in the
database rather than in application code, which also makes duplicate submission naturally
idempotent: the retry returns `409 Conflict` pointing at the existing review. This is why
the API has no `Idempotency-Key` header — the domain already has a natural key.

Helpfulness counters on `reviews` are denormalised for sorting. A vote upserts into
`review_votes` and recomputes both counters from that table in the same transaction —
recompute rather than delta, for the same reason as the rating projection.

## 4. Domain events

Event schemas live in `packages/contracts` as Zod schemas, shared by producer, consumer,
and tests. Every event carries `eventId`, `occurredAt`, and a `version` field so that a
future schema change is additive rather than breaking.

| Event | Emitted when | Consumed by |
|---|---|---|
| `review.submitted` | a review is created or edited by its author | moderation |
| `review.approved` | moderation (auto or manual) approves | aggregation, cache |
| `review.rejected` | moderation rejects | — (audit only) |
| `review.flagged` | automatic moderation is not confident | — (the manual queue reads DB state) |
| `review.unpublished` | a moderator revokes an approved review, or the author deletes it | aggregation, cache |

Editing an approved review returns it to `PENDING` and emits both `review.unpublished`
and `review.submitted`, so the rating never counts text that no longer exists.

## 5. Moderation

The classifier is a pure function, `classify(review, context): Verdict`, with no I/O:
banned-word list, share of uppercase characters, link count, repeated-character runs, and
duplicate body from the same author. It returns `APPROVED`, `REJECTED` with a reason, or
`FLAGGED` for the manual queue. A verified purchase downgrades a borderline `FLAGGED`
verdict to `APPROVED`; it never rescues a `REJECTED` one, because profanity from a real
buyer is still profanity.

Being pure makes it exhaustively unit-testable without infrastructure, and it sits behind
a `ModerationPolicy` port. In production this is where a third-party moderation API or an
LLM call would go; swapping the implementation is a one-file change and no consumer code
moves.

Moderators work the queue through `GET /moderation/reviews?status=FLAGGED` and
`POST /moderation/reviews/:id`, which writes the decision and the outbox event in one
transaction, exactly like the automatic path.

## 6. API

Base path `/api/v1`. OpenAPI served at `/docs`, generated from the Nest decorators and
the shared Zod schemas.

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/auth/login` | — | returns JWT |
| GET | `/auth/me` | user | |
| GET | `/products` | — | `q`, `cursor`, `limit`; embeds rating summary |
| GET | `/products/:slug` | — | product plus summary and histogram |
| GET | `/products/:id/reviews` | — | `sort=helpful\|newest\|rating_desc\|rating_asc`, `rating`, `cursor`, `limit`; `APPROVED` only |
| POST | `/products/:id/reviews` | user | `202 Accepted`, review returned in `PENDING`; `409` if one already exists |
| PATCH | `/reviews/:id` | author | returns the review to `PENDING` and re-triggers moderation |
| DELETE | `/reviews/:id` | author or moderator | |
| PUT | `/reviews/:id/vote` | user, not the author | `{ value }` |
| DELETE | `/reviews/:id/vote` | user | |
| GET | `/me/reviews` | user | the author's own reviews in every status |
| GET | `/moderation/reviews` | moderator | filter by status |
| POST | `/moderation/reviews/:id` | moderator | `{ decision, reason }` |
| GET | `/health`, `/health/ready` | — | liveness and dependency readiness |

Products are addressed by `slug` on the public detail route, because that is what
belongs in a shareable URL, and by `id` everywhere a product appears as a parent
resource. The frontend has the id once it has loaded the detail payload.

Deleting a review is a hard delete, with `review_votes` removed by `ON DELETE CASCADE`,
and it frees the `UNIQUE(product_id, author_id)` slot so the author may write a new one.
A production system would soft-delete instead to retain the moderation audit trail; that
is a column and a filter, not a redesign.

Pagination is cursor-based (opaque base64 of the sort key plus id), not offset — offset
pagination skips or repeats rows when the underlying list changes between pages, which it
constantly does here.

Review submission is rate-limited per user and per IP through a Redis-backed throttler.

## 7. Caching

Redis, cache-aside, applied only where reads are hot and repeated:

- product rating summary
- product detail page payload
- the **first** page of the review list, per sort order

Deep pages are not cached: they are rarely requested and would multiply invalidation
work. TTL is 60 seconds for the summary and product detail and 30 seconds for the review list
page, as a backstop only: the aggregation consumer deletes the affected keys immediately
after updating the summary. The TTL therefore bounds staleness solely in the case where
invalidation itself fails.

Redis sits behind a `CacheService` port, with an in-memory implementation used by tests
that do not target caching behaviour specifically.

## 8. Frontend

Next.js App Router, Tailwind, shadcn/ui.

- `/` — product grid: image, name, price, stars, review count
- `/products/[slug]` — product detail; rating summary with a clickable histogram that
  filters by star; sort control; "load more" review list; helpfulness voting; review form
- `/moderation` — the moderator queue, approve/reject with a reason
- `/login` — email and password, plus a seeded-account picker for convenience in dev

Server Components fetch through the API on the server; mutations go through React Query.
The JWT is stored in an httpOnly cookie set by a Next Route Handler, not in
`localStorage`, so a XSS bug cannot read the token.

Asynchronous moderation is made visible rather than hidden: a freshly submitted review
does not appear in the public list, so the product page shows the author their own review
in a "Your review" block with a "pending moderation" badge. Without this the delay reads
as a bug.

## 9. Testing

- **Unit (Vitest):** moderation policy across its decision space, rating arithmetic,
  cursor encoding/decoding, sort and filter query construction, auth guards.
- **Integration (Vitest + Testcontainers):** real Postgres, Redis, and RabbitMQ. The
  central test drives the whole chain — submit a review, let the relay publish, let the
  consumers run, then assert that the API returns the updated average and histogram. Also
  covers the duplicate-review conflict, moderation transitions, and vote counting.
- **E2E (Playwright):** two flows against `docker compose` — a guest reading reviews, and
  a customer submitting a review that a moderator then approves and that becomes publicly
  visible.

CI (GitHub Actions): one job for lint, typecheck, unit, and integration; a separate job
for E2E. Node 22 LTS is pinned in `.nvmrc`, the Docker images, and CI so the project
builds identically for a reviewer.

## 10. Repository layout

```
apps/api             NestJS HTTP service, owns writes and the outbox
apps/worker          NestJS standalone: outbox relay and event consumers
apps/web             Next.js frontend
packages/contracts   Zod schemas for DTOs and events, shared by all three apps
packages/db          Prisma schema, migrations, seed data
packages/tooling     shared tsconfig, eslint, vitest configuration
docker-compose.yml   the whole system; one command to a working environment
docker-compose.dev.yml  infrastructure only, apps run on the host
docs/design          this document
docs/adr             short records for the contested decisions
README.md
```

pnpm workspaces with Turborepo for task orchestration and caching.

## 11. Trade-offs

**The outbox is more machinery than this traffic requires.** A reviews system for a
catalogue of this size could update the rating in the same transaction as the review and
be done. It is here because the failure it prevents — a lost or phantom event — is the
one that silently corrupts data and is painful to debug in production, and because the
event log is what makes later additions (notifications, search indexing, analytics)
additive instead of invasive. If this were a startup optimising for time to market, I
would start with synchronous aggregates and introduce the outbox at the point where a
second consumer of review events appeared.

**Aggregates are eventually consistent.** An approved review shows up in the average
within the time it takes the relay and consumer to run — normally well under a second,
but not synchronously. The alternative, updating the summary transactionally, serialises
all writes for a popular product on a single row.

**Recompute-over-delta in projections** trades throughput for correctness, as described
in §2.2.

**Authentication is deliberately shallow.** Login, JWT, two roles. No refresh tokens, no
registration, no password reset — that is a solved problem that would consume time
without saying anything about the actual subject, which is reviews.

**No search engine.** Product lookup is `ILIKE` over a small catalogue. Real search means
Postgres full-text or an external engine; the query is isolated in a repository method so
that change stays local.

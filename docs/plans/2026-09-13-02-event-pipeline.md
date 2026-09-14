# Plan 2 — Event Pipeline

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drain the outbox into RabbitMQ and consume those events, so a submitted review is automatically moderated and an approved review updates the product's rating summary and invalidates its caches — with no manual step.

**Architecture:** `apps/worker` is a NestJS standalone application (no HTTP server) running three components: the outbox relay, the moderation consumer, and the aggregation consumer. It shares `@reviews/db` and `@reviews/contracts` with the API and holds no schema of its own. Handlers are idempotent by construction — conditional status transitions and recompute-from-source projections — so at-least-once delivery is safe.

**Tech Stack:** NestJS 11 standalone, `amqplib`, Prisma 6, Vitest 3, Testcontainers (Postgres, Redis, RabbitMQ), pino.

**Spec:** `docs/design/2026-09-13-product-reviews-design.md`

**Depends on:** Plan 1 complete (`docs/plans/2026-09-13-01-foundation-and-api.md`).

## Global Constraints

All of Plan 1's Global Constraints apply unchanged. Additionally:

- Messaging topology names are fixed and referenced by both worker and tests: topic exchange `reviews.events`; dead-letter exchange `reviews.dlx`; queues `moderation.review-submitted` and `aggregation.review-visibility`; dead-letter queues `moderation.review-submitted.dlq` and `aggregation.review-visibility.dlq`.
- Routing keys are exactly the `EVENT_TYPES` values from `@reviews/contracts`.
- **Two distinct failure paths, never conflated.** A *publish* failure in the relay increments `outbox.attempts` and records `last_error`; at `OUTBOX_MAX_ATTEMPTS` (default 5) the row is parked — excluded from polling, retained for inspection, and counted by a log line at `error` level. A *handler* failure in a consumer nacks without requeue, and the broker routes the message to that queue's dead-letter queue. Retrying a poison message in a tight loop is not a retry strategy.
- Every consumer handler must be safe to run twice on the same message. A task that adds a handler must include a test that delivers the same event twice and asserts the second delivery changes nothing.
- The worker exposes no HTTP port. Liveness in Compose is a process check, not an endpoint.

---

### Task 1: Worker skeleton, messaging topology, and publisher

**Files:**
- Create: `apps/worker/package.json`, `tsconfig.json`, `vitest.config.ts`, `vitest.integration.config.ts`
- Create: `apps/worker/src/main.ts`, `src/app.module.ts`, `src/config/env.ts`
- Create: `apps/worker/src/messaging/topology.ts`, `messaging/amqp.connection.ts`, `messaging/event.publisher.ts`, `messaging/messaging.module.ts`
- Test: `apps/worker/src/messaging/topology.test.ts`, `apps/worker/test/publisher.integration.test.ts`, `apps/worker/test/harness.ts`, `apps/worker/test/global-setup.ts`

**Interfaces:**
- Produces:
  - `TOPOLOGY` constant from `src/messaging/topology.ts`:
    ```ts
    export const TOPOLOGY = {
      exchange: 'reviews.events',
      deadLetterExchange: 'reviews.dlx',
      queues: {
        moderation: { name: 'moderation.review-submitted', bindings: ['review.submitted'] },
        aggregation: { name: 'aggregation.review-visibility', bindings: ['review.approved', 'review.unpublished'] },
      },
    } as const;
    export function dlqName(queue: string): string { return `${queue}.dlq`; }
    ```
  - `assertTopology(channel: ConfirmChannel): Promise<void>` — declares both exchanges, every queue with `deadLetterExchange` set, every dead-letter queue, and every binding. Idempotent: safe to call on every boot.
  - `EventPublisher.publish(envelope: EventEnvelope): Promise<void>` — publishes to `TOPOLOGY.exchange` with `routingKey = envelope.eventType`, `persistent: true`, `messageId = envelope.eventId`, and **waits for the publisher confirm**. Rejects if the broker nacks.
  - `apps/worker/test/harness.ts` exporting `createWorkerHarness()` giving `{ prisma, channel, publish, consumeOne(queue, timeoutMs), purgeAll(), close() }`, backed by containers started once in `global-setup.ts`.

- [ ] **Step 1: Write the failing topology unit test**

```ts
import { describe, expect, it } from 'vitest';
import { TOPOLOGY, dlqName } from './topology.js';
import { EVENT_TYPES } from '@reviews/contracts';

describe('TOPOLOGY', () => {
  it('binds every event type that a consumer needs', () => {
    const bound = Object.values(TOPOLOGY.queues).flatMap((q) => q.bindings);
    expect(bound).toContain(EVENT_TYPES.REVIEW_SUBMITTED);
    expect(bound).toContain(EVENT_TYPES.REVIEW_APPROVED);
    expect(bound).toContain(EVENT_TYPES.REVIEW_UNPUBLISHED);
  });

  it('only binds routing keys that are real event types', () => {
    const known = new Set<string>(Object.values(EVENT_TYPES));
    for (const queue of Object.values(TOPOLOGY.queues)) {
      for (const binding of queue.bindings) expect(known).toContain(binding);
    }
  });

  it('derives a dead-letter queue name per queue', () => {
    expect(dlqName(TOPOLOGY.queues.moderation.name)).toBe('moderation.review-submitted.dlq');
  });
});
```

The second case is worth more than it looks: a typo in a routing key produces a queue that silently receives nothing, and that failure is invisible at runtime until someone notices reviews are never moderated.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @reviews/worker test:unit`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the failing publisher integration test**

```ts
it('publishes an event that lands on the bound queue', async () => {
  const envelope = buildEnvelope(EVENT_TYPES.REVIEW_SUBMITTED, { /* valid payload */ });
  await h.publish(envelope);
  const message = await h.consumeOne(TOPOLOGY.queues.moderation.name, 5_000);
  expect(JSON.parse(message.content.toString()).eventId).toBe(envelope.eventId);
});

it('does not deliver an approved event to the moderation queue', async () => {
  await h.publish(buildEnvelope(EVENT_TYPES.REVIEW_APPROVED, { /* ... */ }));
  await expect(h.consumeOne(TOPOLOGY.queues.moderation.name, 1_000)).rejects.toThrow(/timeout/);
});

it('marks messages persistent so a broker restart does not lose them', async () => {
  await h.publish(buildEnvelope(EVENT_TYPES.REVIEW_SUBMITTED, { /* ... */ }));
  const message = await h.consumeOne(TOPOLOGY.queues.moderation.name, 5_000);
  expect(message.properties.deliveryMode).toBe(2);
});

it('declares topology idempotently', async () => {
  await expect(assertTopology(h.channel)).resolves.not.toThrow();
  await expect(assertTopology(h.channel)).resolves.not.toThrow();
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `pnpm --filter @reviews/worker test:integration -- publisher`
Expected: FAIL.

- [ ] **Step 5: Implement**

`amqp.connection.ts` opens a connection with a `ConfirmChannel`, registers `connection.on('error')` and `on('close')` handlers that log and trigger a bounded reconnect with backoff, and calls `assertTopology` on every successful connect.

`event.publisher.ts` serialises the envelope to JSON and uses the callback form of `channel.publish` wrapped in a promise so the confirm is awaited. Publishing without waiting for the confirm means the relay can mark a row published that the broker never accepted — which is the exact failure the outbox exists to prevent, reintroduced one layer up.

`main.ts` uses `NestFactory.createApplicationContext` (not `create`) since there is no HTTP surface, and calls `app.enableShutdownHooks()`.

- [ ] **Step 6: Run to verify the tests pass**

Run: `pnpm --filter @reviews/worker test:unit && pnpm --filter @reviews/worker test:integration -- publisher`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(worker): add standalone worker with RabbitMQ topology and publisher

Declares the topic exchange, both consumer queues, and a dead-letter
queue per consumer on every boot, so a fresh environment needs no
manual broker setup and a redeploy cannot drift from the intended
topology.

The publisher waits for a broker confirm before resolving. Publishing
fire-and-forget would let the relay mark an event delivered that the
broker never accepted, which is the dual-write hazard the outbox was
introduced to remove, reintroduced one layer up.

A test asserts that every declared binding is a real event type: a typo
in a routing key produces a queue that silently receives nothing, and
nothing else in the system would report it."
```

---

### Task 2: Outbox relay

**Files:**
- Create: `apps/worker/src/relay/outbox-relay.service.ts`, `relay/relay.module.ts`, `relay/outbox.repository.ts`
- Test: `apps/worker/test/relay.integration.test.ts`

**Interfaces:**
- Consumes: `EventPublisher` (Task 1), `PrismaClient` from `@reviews/db`.
- Produces: `OutboxRelayService` with `runOnce(): Promise<{ published: number; failed: number }>` — exported separately from the polling loop **so tests drive one batch deterministically instead of sleeping**. `start()`/`stop()` wrap `runOnce` in an interval with `OUTBOX_POLL_INTERVAL_MS` (default 500) and are wired to Nest lifecycle hooks.
- Config: `OUTBOX_BATCH_SIZE` (default 50), `OUTBOX_MAX_ATTEMPTS` (default 5), `OUTBOX_POLL_INTERVAL_MS` (default 500).

- [ ] **Step 1: Write the failing integration test**

```ts
describe('OutboxRelayService.runOnce', () => {
  it('publishes an unpublished row and marks it published', async () => {
    const row = await insertOutboxRow(h.prisma, EVENT_TYPES.REVIEW_SUBMITTED);
    const result = await relay.runOnce();

    expect(result).toEqual({ published: 1, failed: 0 });
    const after = await h.prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.publishedAt).not.toBeNull();
    await expect(h.consumeOne(TOPOLOGY.queues.moderation.name, 5_000)).resolves.toBeDefined();
  });

  it('publishes in id order', async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await insertOutboxRow(h.prisma, EVENT_TYPES.REVIEW_SUBMITTED)).id);
    await relay.runOnce();
    const received = await h.consumeMany(TOPOLOGY.queues.moderation.name, 5);
    expect(received.map((m) => JSON.parse(m.content.toString()).payload.reviewId))
      .toEqual(ids.map(idToReviewId));
  });

  it('does not republish a row it already published', async () => {
    await insertOutboxRow(h.prisma, EVENT_TYPES.REVIEW_SUBMITTED);
    await relay.runOnce();
    expect(await relay.runOnce()).toEqual({ published: 0, failed: 0 });
  });

  it('two concurrent relays never publish the same row twice', async () => {
    for (let i = 0; i < 20; i++) await insertOutboxRow(h.prisma, EVENT_TYPES.REVIEW_SUBMITTED);
    const [a, b] = await Promise.all([relayA.runOnce(), relayB.runOnce()]);
    expect(a.published + b.published).toBe(20);
    const received = await h.consumeMany(TOPOLOGY.queues.moderation.name, 20, 5_000);
    expect(new Set(received.map((m) => m.properties.messageId)).size).toBe(20);
  });

  it('records the error and increments attempts when publishing fails', async () => {
    const row = await insertOutboxRow(h.prisma, EVENT_TYPES.REVIEW_SUBMITTED);
    vi.spyOn(publisher, 'publish').mockRejectedValueOnce(new Error('broker down'));

    expect(await relay.runOnce()).toEqual({ published: 0, failed: 1 });
    const after = await h.prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.publishedAt).toBeNull();
    expect(after.attempts).toBe(1);
    expect(after.lastError).toMatch(/broker down/);
  });

  it('parks a row after the maximum number of attempts', async () => {
    const row = await insertOutboxRow(h.prisma, EVENT_TYPES.REVIEW_SUBMITTED, { attempts: 5 });
    vi.spyOn(publisher, 'publish').mockRejectedValue(new Error('still down'));
    expect(await relay.runOnce()).toEqual({ published: 0, failed: 0 });
    expect((await h.prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } })).attempts).toBe(5);
  });

  it('leaves the row unpublished if the transaction fails after publishing', async () => {
    // publish succeeds, the mark-published UPDATE throws
    const row = await insertOutboxRow(h.prisma, EVENT_TYPES.REVIEW_SUBMITTED);
    vi.spyOn(repository, 'markPublished').mockRejectedValueOnce(new Error('db gone'));
    await relay.runOnce().catch(() => undefined);
    expect((await h.prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } })).publishedAt).toBeNull();
    // the next run republishes: at-least-once, and the consumer must tolerate it
    await relay.runOnce();
    const received = await h.consumeMany(TOPOLOGY.queues.moderation.name, 2, 5_000);
    expect(received).toHaveLength(2);
  });
});
```

The concurrency case and the final case are the two that justify this design. The last one states the guarantee out loud: the relay is at-least-once, duplicates are expected, and every consumer must cope.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @reviews/worker test:integration -- relay`
Expected: FAIL.

- [ ] **Step 3: Implement**

`OutboxRepository.claimBatch(tx, limit, maxAttempts)`:

```sql
SELECT id, event_type, aggregate_id, aggregate_type, payload, occurred_at, attempts
FROM outbox
WHERE published_at IS NULL AND attempts < $2
ORDER BY id
FOR UPDATE SKIP LOCKED
LIMIT $1
```

`SKIP LOCKED` is what lets a second relay instance take the next rows instead of blocking on the first one's locks, and the row locks are what stop both from taking the same row. `ORDER BY id` preserves per-aggregate ordering, which matters for the unpublish-then-resubmit pair from Plan 1 Task 13.

`runOnce` opens one transaction, claims a batch, and for each row publishes and then marks it published within that same transaction. Rows that fail to publish get `attempts + 1` and `last_error` written in a **separate** transaction, so one bad row does not roll back the successful publishes in the batch.

Ordering inside `runOnce` is: publish first, then mark published. The reverse would lose an event if the process died between the two. Publishing first can duplicate an event, which is the failure the consumers are built to absorb.

Wire `start()`/`stop()` to `OnApplicationBootstrap` and `OnApplicationShutdown`, and guard against overlapping runs with a simple in-flight flag so a slow batch cannot stack up behind the interval.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @reviews/worker test:integration -- relay`
Expected: PASS, all seven cases.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(worker): relay outbox rows to RabbitMQ with SKIP LOCKED claiming

Each pass claims a batch with FOR UPDATE SKIP LOCKED, which lets
several relay instances drain the journal in parallel: the row locks
stop two of them taking the same row, and SKIP LOCKED stops the second
blocking behind the first. A test runs two relays over twenty rows and
asserts twenty distinct messages.

Rows are published before they are marked published. The opposite order
loses an event whenever the process dies between the two steps, whereas
this order can only duplicate, never lose — and every consumer is built
to absorb duplicates. The test suite states that guarantee explicitly
rather than leaving it as folklore.

Be precise about how much it can duplicate. The batch shares one
transaction, because the row lock is what stops a second relay claiming
the same rows, so a database failure part-way through aborts the whole
batch — including rows the broker has already accepted. Those are
republished on the next pass. The blast radius is therefore one batch,
bounded by `OUTBOX_BATCH_SIZE`, not one event. That is still
at-least-once and still absorbed by idempotent consumers, but a comment
claiming "one event" would be wrong.

Because the transaction stays open across real broker round-trips, set
an explicit `timeout` on it rather than inheriting Prisma's silent 5s
default, and size the batch to fit that budget. The ceiling on batch
size here is the transaction timeout, not throughput.

A row that fails to publish records the error and its attempt count in
its own transaction, so one poisonous row does not roll back the
successful publishes beside it, and is parked once the attempt budget
is spent rather than retried forever."
```

---

### Task 3: Moderation policy

**Files:**
- Create: `apps/worker/src/moderation/policy.ts`, `moderation/banned-words.ts`, `moderation/policy.types.ts`
- Test: `apps/worker/src/moderation/policy.test.ts`

**Interfaces:**
- Produces, with no I/O of any kind:
  ```ts
  export interface ModerationInput {
    title: string;
    body: string;
    rating: number;
    verifiedPurchase: boolean;
    authorPreviousBodies: string[];
  }
  export type Verdict =
    | { decision: 'APPROVED'; reason: null }
    | { decision: 'REJECTED'; reason: string }
    | { decision: 'FLAGGED'; reason: string };
  export interface ModerationPolicy { classify(input: ModerationInput): Verdict; }
  export const defaultPolicy: ModerationPolicy;
  ```

- [ ] **Step 1: Write the failing unit tests**

```ts
import { describe, expect, it } from 'vitest';
import { defaultPolicy } from './policy.js';

const base = { title: 'Solid product', body: 'Used it for two months and it still works perfectly.', rating: 4, verifiedPurchase: false, authorPreviousBodies: [] };
const classify = (over: Partial<typeof base> = {}) => defaultPolicy.classify({ ...base, ...over });

describe('defaultPolicy', () => {
  it('approves an ordinary review', () => {
    expect(classify()).toEqual({ decision: 'APPROVED', reason: null });
  });

  it('rejects a review containing a banned word', () => {
    const verdict = classify({ body: 'This is complete garbage, you <slur> sellers.' });
    expect(verdict.decision).toBe('REJECTED');
    expect(verdict.reason).toMatch(/language/i);
  });

  it('rejects a review that is mostly links', () => {
    const verdict = classify({ body: 'Buy cheaper at http://a.example http://b.example http://c.example' });
    expect(verdict.decision).toBe('REJECTED');
    expect(verdict.reason).toMatch(/link/i);
  });

  it('flags shouting rather than rejecting it', () => {
    expect(classify({ body: 'ABSOLUTELY TERRIBLE DO NOT BUY THIS EVER AGAIN' }).decision).toBe('FLAGGED');
  });

  it('flags a review duplicated from the same author', () => {
    const body = 'Used it for two months and it still works perfectly.';
    expect(classify({ body, authorPreviousBodies: [body] }).decision).toBe('FLAGGED');
  });

  it('flags long runs of repeated characters', () => {
    expect(classify({ body: 'Greaaaaaaaaaaaaat product, really greaaaaaaaat.' }).decision).toBe('FLAGGED');
  });

  it('approves a borderline review from a verified purchaser', () => {
    const shouty = { body: 'ABSOLUTELY TERRIBLE DO NOT BUY THIS EVER AGAIN' };
    expect(classify({ ...shouty, verifiedPurchase: false }).decision).toBe('FLAGGED');
    expect(classify({ ...shouty, verifiedPurchase: true }).decision).toBe('APPROVED');
  });

  it('does not let a verified purchase rescue a rejection', () => {
    expect(classify({ body: 'You <slur> sellers.', verifiedPurchase: true }).decision).toBe('REJECTED');
  });

  it('checks the title as well as the body', () => {
    expect(classify({ title: 'ABSOLUTE <slur>' }).decision).toBe('REJECTED');
  });

  it('is a pure function', () => {
    const input = { ...base };
    const snapshot = structuredClone(input);
    defaultPolicy.classify(input);
    expect(input).toEqual(snapshot);
  });

  it.each([
    ['a one-word body under the caps rule', 'OK'],
    ['an acronym-heavy but normal review', 'The USB-C PD charging works with my MBP and my XPS.'],
  ])('does not flag %s', (_label, body) => {
    expect(classify({ body }).decision).toBe('APPROVED');
  });
});
```

The final two cases are the ones that keep the caps heuristic honest: a naive uppercase-ratio rule flags every review that mentions `USB-C` or `MBP`, and that false positive is what makes automatic moderation useless in practice.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @reviews/worker test:unit -- policy`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`policy.ts` evaluates rules in a fixed order and returns on the first decisive one: banned words (reject), link density above two URLs or more than 20% of tokens (reject), then the flag-level rules — uppercase ratio above 60% measured over *letters only and only for texts longer than 40 characters*, character runs of five or more, and an exact-match duplicate against `authorPreviousBodies`. If any flag-level rule fired and `verifiedPurchase` is true, the verdict is downgraded to `APPROVED`; reject-level rules are never downgraded.

Keep `banned-words.ts` a small, obviously-illustrative list with a comment stating plainly that a real deployment uses a maintained list or a moderation API, and that this module exists to make the pipeline demonstrable, not to be a content-safety product.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @reviews/worker test:unit -- policy`
Expected: PASS, all thirteen cases.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(worker): add the automatic moderation policy as a pure function

classify() takes a review and returns approve, reject, or flag with no
I/O, so its entire decision space is unit-testable without a database,
a broker, or a network.

Reject-level rules and flag-level rules are separated deliberately: a
verified purchase downgrades a borderline flag to an approval but never
rescues a rejection, since profanity from a genuine buyer is still
profanity.

The uppercase heuristic ignores short texts and measures letters only,
because the naive version flags every review that mentions USB-C. Two
tests pin that false positive down, as it is the failure that makes
automatic moderation worse than none.

The word list is illustrative. The policy sits behind an interface so
that swapping in a moderation API or a model changes one file."
```

---

### Task 4: Moderation consumer

**Files:**
- Create: `apps/worker/src/moderation/moderation.consumer.ts`, `moderation/moderation.module.ts`, `moderation/moderation.repository.ts`
- Create: `apps/worker/src/messaging/consumer.base.ts`
- Test: `apps/worker/test/moderation-consumer.integration.test.ts`

**Interfaces:**
- Consumes: `defaultPolicy` (Task 3), `writeOutboxEvent` from `@reviews/db` (Plan 1 Task 10), `TOPOLOGY` (Task 1).
- Produces: `consumer.base.ts` exporting `registerConsumer(channel, queue, handler)` — parses the envelope with the matching Zod schema, `ack`s on success, `nack(msg, false, false)` on failure so the broker dead-letters it, logs with the `eventId` and queue name, and sets `channel.prefetch(10)`.
- `ModerationConsumer.handle(event: ReviewSubmittedEvent): Promise<void>`.

- [ ] **Step 1: Write the failing integration test**

```ts
it('approves a clean review and emits an approved event', async () => {
  const review = await seedPendingReview(h.prisma, { body: 'Used it daily for three months, no issues.' });
  await consumer.handle(submittedEventFor(review));

  const after = await h.prisma.review.findUniqueOrThrow({ where: { id: review.id } });
  expect(after.status).toBe('APPROVED');
  expect(after.publishedAt).not.toBeNull();

  const events = await h.prisma.outboxEvent.findMany({ where: { aggregateId: review.id }, orderBy: { id: 'asc' } });
  expect(events.map((e) => e.eventType)).toEqual(['review.approved']);
});

it('rejects a review with banned language and records the reason', async () => { /* status REJECTED, moderationReason set, one review.rejected row, publishedAt null */ });

it('flags a suspicious review without emitting a visibility event', async () => {
  // status FLAGGED; exactly one review.flagged row; no review.approved row, because nothing became visible
});

it('is idempotent under redelivery', async () => {
  const review = await seedPendingReview(h.prisma, { body: 'Used it daily for three months, no issues.' });
  const event = submittedEventFor(review);
  await consumer.handle(event);
  await consumer.handle(event);

  expect(await h.prisma.outboxEvent.count({ where: { aggregateId: review.id } })).toBe(1);
  expect((await h.prisma.review.findUniqueOrThrow({ where: { id: review.id } })).status).toBe('APPROVED');
});

it('does nothing when a moderator already decided', async () => {
  const review = await seedReview(h.prisma, { status: 'REJECTED', moderationReason: 'manual' });
  await consumer.handle(submittedEventFor(review));
  const after = await h.prisma.review.findUniqueOrThrow({ where: { id: review.id } });
  expect(after.status).toBe('REJECTED');
  expect(after.moderationReason).toBe('manual');
});

it('does nothing when the review no longer exists', async () => {
  await expect(consumer.handle(submittedEventFor({ id: randomUUID(), productId: randomUUID() }))).resolves.not.toThrow();
});

it('passes the author previous bodies to the policy', async () => {
  // seed two reviews by the same author with identical bodies on different products;
  // the second must be FLAGGED as a duplicate
});

it('dead-letters a message whose payload does not match the schema', async () => {
  await h.publishRaw(TOPOLOGY.queues.moderation.name, { garbage: true });
  const dead = await h.consumeOne(dlqName(TOPOLOGY.queues.moderation.name), 5_000);
  expect(dead).toBeDefined();
});
```

The fifth case — a moderator already decided — is the race that actually happens: a human works the queue while the automatic pass is still in flight. The conditional update is what makes the human win.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @reviews/worker test:integration -- moderation-consumer`
Expected: FAIL.

- [ ] **Step 3: Implement**

`handle` runs one transaction:

```ts
await prisma.$transaction(async (tx) => {
  const review = await tx.review.findUnique({ where: { id: event.payload.reviewId } });
  if (!review || review.status !== 'PENDING') return;              // redelivery, or a human got there first

  const previous = await tx.review.findMany({
    where: { authorId: review.authorId, id: { not: review.id } },
    select: { body: true }, take: 20,
  });

  const verdict = policy.classify({ ...review, authorPreviousBodies: previous.map((p) => p.body) });

  const updated = await tx.review.updateMany({
    where: { id: review.id, status: 'PENDING' },                    // the guard and the write are one statement
    data: {
      status: verdict.decision,
      moderationReason: verdict.reason,
      publishedAt: verdict.decision === 'APPROVED' ? new Date() : null,
    },
  });
  if (updated.count === 0) return;

  await writeOutboxEvent(tx, { eventType: eventTypeFor(verdict.decision), aggregateId: review.id, payload: { /* ... */ } });
});
```

The early `return` on a non-`PENDING` status handles both redelivery and the manual-decision race; the `updateMany` predicate closes the window between the read and the write. `FLAGGED` emits `review.flagged` but no visibility event, because a flagged review is not published and the projection has nothing to recompute.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @reviews/worker test:integration -- moderation-consumer`
Expected: PASS, all eight cases.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(worker): moderate submitted reviews automatically

The handler only acts on a review still in PENDING, and the status
change is a conditional update predicated on that same state. That one
predicate covers two different races at once: a redelivered message,
and a human moderator who reached the queue first. In both cases the
handler becomes a no-op rather than overwriting a decision.

A flagged review emits a flagged event but no visibility event, since
nothing became visible and the rating projection has nothing to
recompute.

Messages whose payload does not match the schema are dead-lettered
rather than retried. A malformed message will not become well-formed
on the third attempt, and requeueing it starves the queue behind it."
```

---

### Task 5: Rating aggregation and cache invalidation

**Files:**
- Create: `apps/worker/src/aggregation/aggregation.consumer.ts`, `aggregation/summary.repository.ts`, `aggregation/aggregation.module.ts`
- Create: `apps/worker/src/cache/redis-cache.service.ts` (reusing the port from Plan 1 Task 9)
- Test: `apps/worker/test/aggregation-consumer.integration.test.ts`

**Interfaces:**
- Consumes: `cacheKeys` from `@reviews/contracts` (Plan 1 Task 9), `TOPOLOGY` (Task 1).
- Produces: `SummaryRepository.recompute(tx, productId): Promise<void>` and `AggregationConsumer.handle(event): Promise<void>` bound to `review.approved` and `review.unpublished`.

- [ ] **Step 1: Write the failing integration test**

```ts
it('computes the summary from approved reviews only', async () => {
  const product = await seedProduct(h.prisma);
  await seedReviews(h.prisma, product.id, [
    { rating: 5, status: 'APPROVED' }, { rating: 5, status: 'APPROVED' },
    { rating: 4, status: 'APPROVED' }, { rating: 1, status: 'APPROVED' },
    { rating: 1, status: 'PENDING' },  { rating: 1, status: 'REJECTED' },
  ]);

  await consumer.handle(approvedEventFor(product.id));

  const summary = await h.prisma.productRatingSummary.findUniqueOrThrow({ where: { productId: product.id } });
  expect(summary.reviewCount).toBe(4);
  expect(Number(summary.averageRating)).toBe(3.75);
  expect([summary.count1, summary.count2, summary.count3, summary.count4, summary.count5]).toEqual([1, 0, 0, 1, 2]);
});

it('produces the same summary no matter how many times the event is delivered', async () => {
  const product = await seedProduct(h.prisma);
  await seedReviews(h.prisma, product.id, [{ rating: 5, status: 'APPROVED' }]);
  const event = approvedEventFor(product.id);

  await consumer.handle(event);
  const first = await h.prisma.productRatingSummary.findUniqueOrThrow({ where: { productId: product.id } });
  await consumer.handle(event);
  await consumer.handle(event);
  const third = await h.prisma.productRatingSummary.findUniqueOrThrow({ where: { productId: product.id } });

  expect({ ...third, updatedAt: null }).toEqual({ ...first, updatedAt: null });
});

it('drops the summary to zero when the last approved review is unpublished', async () => {
  // seed one approved review, recompute, then delete it and handle review.unpublished
  // expect reviewCount 0, averageRating 0, all distribution counts 0 — the row must exist, not vanish
});

it('creates the summary row when none exists yet', async () => { /* upsert, not update */ });

it('invalidates exactly the cache keys the API reads', async () => {
  const product = await seedProduct(h.prisma);
  await cache.set(cacheKeys.productDetail(product.slug), { stale: true }, 60);
  await cache.set(cacheKeys.productSummary(product.id), { stale: true }, 60);
  await cache.set(cacheKeys.reviewListFirstPage(product.id, 'helpful', null), { stale: true }, 30);
  await cache.set('unrelated:key', { keep: true }, 60);

  await consumer.handle(approvedEventFor(product.id));

  expect(await cache.get(cacheKeys.productDetail(product.slug))).toBeNull();
  expect(await cache.get(cacheKeys.productSummary(product.id))).toBeNull();
  expect(await cache.get(cacheKeys.reviewListFirstPage(product.id, 'helpful', null))).toBeNull();
  expect(await cache.get('unrelated:key')).not.toBeNull();
});

it('still updates the database when cache invalidation fails', async () => {
  vi.spyOn(cache, 'del').mockRejectedValueOnce(new Error('redis down'));
  await expect(consumer.handle(approvedEventFor(product.id))).resolves.not.toThrow();
  // the summary is written; staleness is bounded by TTL
});
```

The last case encodes a real decision: Redis being down must not stop the rating from being correct in Postgres. A cache failure degrades freshness for up to the TTL; it must not degrade correctness or block the pipeline.

The `unrelated:key` assertion in the invalidation case guards against a prefix delete that is too broad — the kind of bug that empties the whole cache on every approval and is invisible except as a mysterious drop in hit rate.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @reviews/worker test:integration -- aggregation-consumer`
Expected: FAIL.

- [ ] **Step 3: Implement**

`SummaryRepository.recompute` is one upsert driven by one aggregate query:

```sql
INSERT INTO product_rating_summary (product_id, review_count, rating_sum, average_rating,
                                    count_1, count_2, count_3, count_4, count_5, updated_at)
SELECT $1,
       count(*),
       coalesce(sum(rating), 0),
       coalesce(round(avg(rating)::numeric, 2), 0),
       count(*) FILTER (WHERE rating = 1), count(*) FILTER (WHERE rating = 2),
       count(*) FILTER (WHERE rating = 3), count(*) FILTER (WHERE rating = 4),
       count(*) FILTER (WHERE rating = 5),
       now()
FROM reviews WHERE product_id = $1 AND status = 'APPROVED'
ON CONFLICT (product_id) DO UPDATE SET
  review_count = EXCLUDED.review_count, rating_sum = EXCLUDED.rating_sum,
  average_rating = EXCLUDED.average_rating,
  count_1 = EXCLUDED.count_1, count_2 = EXCLUDED.count_2, count_3 = EXCLUDED.count_3,
  count_4 = EXCLUDED.count_4, count_5 = EXCLUDED.count_5, updated_at = now()
```

One statement, no read-modify-write, and therefore idempotent by construction — that is the whole reason the projection recomputes rather than increments. The `coalesce` around `avg` is what makes the empty case produce a zero row instead of a null one.

Cache invalidation happens **after** the transaction commits, never inside it: a rollback after a delete would leave the cache correct and the database not, but a delete inside an uncommitted transaction can be seen by readers before the new value is visible. Wrap it in try/catch and log at `warn` — a failure here is a freshness problem bounded by the TTL, not a correctness one.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @reviews/worker test:integration -- aggregation-consumer`
Expected: PASS, all six cases.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(worker): recompute rating summaries and invalidate caches

The summary is recomputed from approved reviews in a single upsert
rather than adjusted by a delta. That makes the projection idempotent
by construction: a duplicate delivery writes the same row, and the
projection cannot drift from the reviews it summarises. The cost is a
scan per product per event, which is the right trade at this scale and
is documented in the design along with the point at which it stops
being so.

Cache invalidation runs after the commit and cannot fail the handler. A
Redis outage should cost freshness up to the TTL, not correctness, and
certainly not the ability to record the rating at all.

The invalidation test asserts that an unrelated key survives, since a
prefix delete that is one character too broad empties the cache on
every approval and shows up only as an unexplained drop in hit rate."
```

---

### Task 6: End-to-end pipeline test and worker wiring

**Files:**
- Modify: `apps/worker/src/app.module.ts` (wire relay, consumers, graceful shutdown)
- Create: `apps/worker/src/observability/logger.ts`
- Test: `apps/worker/test/pipeline.integration.test.ts`

**Interfaces:**
- Produces: a worker process that, once started, needs no manual intervention for a submitted review to become visible.

- [ ] **Step 1: Write the failing end-to-end pipeline test**

This is the test the whole architecture exists to pass. It boots the API and the worker together against shared containers and asserts the observable outcome, touching no internals.

```ts
it('publishes a clean review and updates the rating through the whole pipeline', async () => {
  const token = await api.loginAs('alice@example.com');
  const product = await createProduct(api.prisma, { slug: 'desk-lamp' });
  await seedApprovedReviews(api.prisma, product.id, [5, 3]); // existing average 4.00
  await worker.recomputeNow(product.id);

  const before = await api.request.get('/api/v1/products/desk-lamp').expect(200);
  expect(before.body.summary).toMatchObject({ reviewCount: 2, averageRating: 4 });

  await api.request.post(`/api/v1/products/${product.id}/reviews`)
    .auth(token, { type: 'bearer' })
    .send({ rating: 1, title: 'Broke in a week', body: 'The switch failed after six days of light use.' })
    .expect(202);

  await worker.start();
  await waitFor(async () => {
    const res = await api.request.get('/api/v1/products/desk-lamp');
    expect(res.body.summary.reviewCount).toBe(3);
  }, { timeout: 15_000, interval: 250 });

  const after = await api.request.get('/api/v1/products/desk-lamp').expect(200);
  expect(after.body.summary).toMatchObject({
    reviewCount: 3,
    averageRating: 3,
    distribution: { '1': 1, '2': 0, '3': 1, '4': 0, '5': 1 },
  });

  const list = await api.request.get(`/api/v1/products/${product.id}/reviews?sort=newest`).expect(200);
  expect(list.body.items[0]).toMatchObject({ title: 'Broke in a week', status: 'APPROVED' });
});

it('keeps a rejected review out of the rating and out of the public list', async () => {
  // submit a review with banned language; wait for status REJECTED via GET /me/reviews;
  // assert the summary is unchanged and the public list does not contain it
});

it('routes a flagged review to the moderation queue and publishes it on approval', async () => {
  // submit shouting from a non-verified user; wait for FLAGGED;
  // assert it appears in GET /moderation/reviews and not in the public list;
  // approve it through the moderation endpoint; wait; assert the summary now counts it
});

it('survives a duplicated outbox delivery without double-counting', async () => {
  // submit one review, let the pipeline settle, then replay the same envelope through the publisher
  // assert reviewCount is unchanged
});
```

`waitFor` polls rather than sleeping a fixed duration: a fixed sleep is either flaky or slow, and usually both.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @reviews/worker test:integration -- pipeline`
Expected: FAIL — the consumers are not wired to the queues yet.

- [ ] **Step 3: Implement the wiring**

`AppModule` registers the relay and both consumers, subscribing each to its queue through `registerConsumer`. `logger.ts` configures pino with the `eventId`, `queue`, and `reviewId` as standard fields, so a single review can be traced across the relay and both consumers by grepping one id.

Graceful shutdown: on `SIGTERM`, stop the relay interval, stop consuming new messages (`channel.cancel`), wait for in-flight handlers to finish with a bounded timeout, then close the channel, the connection, and the Prisma client. Without the cancel-then-drain order, a redeploy nacks whatever was in flight and produces avoidable dead letters on every deployment.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @reviews/worker test:integration -- pipeline`
Expected: PASS, all four cases.

Then run the whole suite for both apps to confirm nothing regressed:
Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(worker): wire the pipeline end to end with graceful shutdown

Boots the relay and both consumers together, so a submitted review
reaches the catalogue without anyone touching a queue.

The accompanying test asserts only observable behaviour: it posts a
review through the HTTP API and waits for the product's average rating
to change, with no reaching into the outbox or the broker. That is what
makes it a test of the architecture rather than of its parts, and it
would catch a broken binding, a missed event type, or a stale cache
that unit tests each individually pass.

Shutdown cancels consumers and drains in-flight handlers before
closing the connection. Closing first nacks whatever was being handled,
turning every routine redeploy into a batch of dead letters."
```

---

## Plan 2 self-review

**Spec coverage.** §2.1 write path: relay → Task 2, publisher → Task 1, both consumers → Tasks 4 and 5. §2.1 dead-lettering → Tasks 1 and 4, with the relay-parking-versus-DLQ distinction stated in Global Constraints. §2.2 idempotency: conditional transitions → Task 4, recompute projection → Task 5, and both have explicit redelivery tests. §4 domain events: all five types are produced or consumed — `review.submitted` (Task 4 in), `review.approved` / `review.rejected` / `review.flagged` (Task 4 out), `review.approved` / `review.unpublished` (Task 5 in). `review.rejected` is intentionally unconsumed; it exists for audit and for future subscribers, and Task 1's binding test tolerates that because it only asserts that bound keys are real, not that every key is bound. §5 moderation → Task 3 (policy) and Task 4 (consumer). §7 cache invalidation → Task 5.

**Interface consistency with Plan 1.** `writeOutboxEvent(tx, event)` is imported from `@reviews/db` in Task 4, the same function Plan 1 Tasks 10, 13, and 14 write with. `cacheKeys.*` in Task 5 are the builders defined in Plan 1 Task 9 in `packages/contracts`. `EVENT_TYPES` is the single source in both plans. The `ProductRatingSummary` column names used in Task 5's SQL (`count_1`..`count_5`, `rating_sum`, `average_rating`) match the Prisma model in Plan 1 Task 4.

**Deferred to Plan 3:** the frontend, the full-stack Compose file including application containers, CI, the README, and the ADRs.

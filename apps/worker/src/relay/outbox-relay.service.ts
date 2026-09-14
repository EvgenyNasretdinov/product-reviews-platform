import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { PrismaClient } from '@reviews/db';
import type { EventEnvelope, EventPublisher } from '../messaging/event.publisher.js';
import { forEvent } from '../observability/logger.js';
import { OutboxRepository, parseEnvelope } from './outbox.repository.js';

export interface OutboxRelayConfig {
  batchSize: number;
  maxAttempts: number;
  pollIntervalMs: number;
}

export interface RunOnceResult {
  published: number;
  failed: number;
}

interface FailedRow {
  id: bigint;
  error: Error;
}

/**
 * Worst-case per-row budget, in milliseconds — both for sizing the batch
 * transaction's timeout below *and*, since I1's review, the actual
 * client-side deadline each individual `publisher.publish` call is raced
 * against (see {@link withDeadline}). A healthy confirm round-trip is
 * single digits of milliseconds; this budgets two orders of magnitude
 * worse — a slow or backpressured broker — for every row in the batch.
 * Deliberately generous rather than tight: a relay that spuriously fails
 * rows because nobody sized the budget is a worse failure mode than one
 * that occasionally runs a little long. `EventPublisher.publish` resolves
 * only on the broker's confirm, and a standard RabbitMQ backpressure
 * signal (a memory or disk alarm) is the broker accepting the frame and
 * never confirming it — with no deadline of its own, that promise never
 * settles, so without this race the whole batch transaction (and every
 * later poll, since `currentTick` never clears) would hang forever on one
 * stuck row instead of recording an ordinary publish failure and moving
 * on.
 */
const PER_ROW_PUBLISH_BUDGET_MS = 200;

/**
 * Fixed addition to the batch transaction's timeout, covering overhead
 * that doesn't scale with batch size: acquiring a pool connection,
 * Postgres planning the claim query, committing.
 */
const TRANSACTION_TIMEOUT_HEADROOM_MS = 2_000;

/**
 * How long {@link OutboxRelayService.stopAndDrain} waits for a batch
 * already in flight to finish before giving up and returning anyway,
 * mirroring `PipelineLifecycle`'s `DRAIN_TIMEOUT_MS` for consumer drain in
 * `app.module.ts`. Without this bound, a `runOnce()` stuck on a publish
 * that somehow evaded {@link PER_ROW_PUBLISH_BUDGET_MS} (or stuck
 * anywhere else inside the transaction) would make `stopAndDrain` — and
 * therefore `onApplicationShutdown`, and therefore `app.close()` — hang
 * forever, turning a routine `SIGTERM` into a process that never exits.
 */
const STOP_AND_DRAIN_TIMEOUT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Races `promise` against a `ms`-millisecond timer. If the timer wins,
 * the returned promise rejects with `message`; `promise` itself is never
 * cancelled (there is no way to cancel an in-flight amqplib publish or
 * Prisma call), it is simply no longer awaited by the caller. Both
 * branches of the race are given a rejection handler, so a `promise` that
 * eventually settles after the timeout has already fired can never
 * surface as an unhandled rejection.
 */
function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Drains the transactional outbox into the broker. This is the seam
 * between the two halves of the outbox pattern: Plan 1 writes every
 * domain event atomically with the state change that caused it, and this
 * service is what turns that durable row into a message the rest of the
 * system can act on. Everything about its ordering exists to preserve the
 * one guarantee the outbox pattern is for — at-least-once delivery, never
 * zero — even though every individual write here can fail independently.
 *
 * `runOnce` is exported as a plain method, separate from the interval
 * loop `start`/`stop` wrap it in, specifically so a test can drive one
 * batch deterministically instead of starting the loop and sleeping until
 * it hopes something happened.
 */
@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OutboxRelayService.name);
  private timer: NodeJS.Timeout | undefined;
  // The in-flight tick's own promise, not just a boolean — `stop()` alone
  // only clears the interval, so a batch already inside `runOnce()` (mid
  // transaction, possibly mid-publish) keeps running after `stop()`
  // returns. `stopAndDrain()` is what a caller needing a real guarantee —
  // graceful shutdown, specifically — awaits instead: it stops the loop
  // *and* waits for whichever tick was already running to actually finish.
  private currentTick: Promise<void> | undefined;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly publisher: EventPublisher,
    private readonly repository: OutboxRepository,
    private readonly config: OutboxRelayConfig,
  ) {}

  onApplicationBootstrap(): void {
    this.start();
  }

  /** Starts the polling loop. A no-op if already started. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick();
    }, this.config.pollIntervalMs);
    // Never keep the process alive on its own — only real work should.
    this.timer.unref();
  }

  /**
   * Stops the polling loop without waiting for a batch already in flight
   * to finish. A no-op if already stopped. Exported mainly for tests that
   * want the loop off without paying for a drain; graceful shutdown uses
   * {@link stopAndDrain} instead, precisely because this alone is not
   * enough to guarantee nothing is still running when it returns.
   */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Stops the polling loop and waits for any tick already in flight to
   * finish — the real drain `stop()` alone only nominally provides. This
   * is what `AppModule`'s shutdown orchestrator calls: without it, a
   * `SIGTERM` that lands mid-batch would return from `stop()`
   * immediately while a transaction was still open, and the orchestrator
   * would go on to close the channel and connection underneath it,
   * turning an in-flight publish into a failure instead of letting it
   * finish and commit cleanly.
   *
   * Bounded by {@link STOP_AND_DRAIN_TIMEOUT_MS}, mirroring
   * `PipelineLifecycle.drainConsumers` right below it in the shutdown
   * sequence: if the in-flight tick hasn't finished by the deadline, this
   * logs a warning and returns anyway rather than hanging
   * `onApplicationShutdown` (and therefore `app.close()`, and therefore
   * `SIGTERM`) forever. `currentTick` itself never rejects (see `tick`'s
   * doc comment), so the only way this could otherwise hang is a batch
   * genuinely stuck — which {@link withDeadline} around each publish is
   * what keeps from happening in the first place; this is the backstop
   * for every other way a transaction could stall.
   */
  async stopAndDrain(): Promise<void> {
    this.stop();
    if (!this.currentTick) return;

    const timedOut = await Promise.race([
      this.currentTick.then(() => false),
      sleep(STOP_AND_DRAIN_TIMEOUT_MS).then(() => true),
    ]);
    if (timedOut) {
      this.logger.warn(
        `outbox relay: stopAndDrain timed out after ${STOP_AND_DRAIN_TIMEOUT_MS}ms waiting for the in-flight batch to finish`,
      );
    }
  }

  /**
   * One interval tick. Guarded by `currentTick` so a batch that runs
   * longer than `pollIntervalMs` cannot stack a second call behind it —
   * without this, a slow batch (a sluggish broker, a large backlog) would
   * pile up concurrent `runOnce` calls against the same instance, each
   * claiming whatever the others left, for no benefit over just letting
   * one run to completion and starting the next tick after. Never itself
   * rejects — `runOnce`'s own failure is caught and logged — so
   * `stopAndDrain` can safely `await currentTick` without a `.catch`.
   */
  private tick(): void {
    if (this.currentTick) return;
    const run = this.runOnce()
      .then(
        () => undefined,
        (error: unknown) => {
          this.logger.error('outbox relay: poll failed', error instanceof Error ? error.stack : String(error));
        },
      )
      .finally(() => {
        this.currentTick = undefined;
      });
    this.currentTick = run;
  }

  /**
   * Claims one batch and drains it. Ordering inside the loop is
   * deliberate: **publish first, then mark published.** The reverse order
   * would lose an event outright if the process died between the two
   * steps — a row marked published that the broker never actually
   * received. Publishing first can only *duplicate* a message if the
   * process dies (or the mark-published write fails) after the broker
   * already confirmed it, and every consumer downstream of this relay is
   * built to absorb a duplicate delivery.
   *
   * The whole claim-publish-mark sequence for the batch runs in **one**
   * transaction — the row locks from `FOR UPDATE SKIP LOCKED` are what
   * stop a second relay instance claiming the same rows, and that only
   * works for as long as the transaction holding them stays open, which
   * means it has to stay open across every publish in the batch, not just
   * the claim. A row that fails to *publish* does **not** abort that
   * transaction — its failure is caught, and the loop moves on to the
   * rest of the batch — because rolling back the whole transaction over
   * one bad row would also roll back every successful publish committed
   * beside it. Failures are instead recorded afterwards, each in
   * {@link OutboxRepository.recordFailure}'s own transaction.
   *
   * A failure in `markPublished` itself is different and deliberately
   * *not* caught, and its blast radius is wider than one row: an
   * uncaught error aborts the **whole** batch transaction, which
   * republishes not just this row but every row already published
   * earlier in the same batch — bounded by `OUTBOX_BATCH_SIZE`, not by
   * one event. The alternative — committing each row's publish-then-mark
   * in its own transaction — would shrink that blast radius to a single
   * row, but at the cost of acquiring and releasing the claim lock once
   * per row instead of once per batch; this task keeps the batch-wide
   * transaction and accepts the wider (but still bounded, still
   * at-least-once) blast radius instead. The `timeout` passed to
   * `$transaction` below exists because of this same shape: real publish
   * round-trips happen while the batch's row locks are held open, so the
   * transaction has to be given more room than Prisma's 5s default before
   * a slow broker makes it fail outright. That `timeout` bounds the
   * **database transaction** only — it is enforced by Prisma's query
   * engine, which has no visibility into (and no power to cancel) a
   * pending `channel.publish` callback — so it does nothing to protect
   * the JavaScript control flow above from a broker that accepts a frame
   * and never confirms it. {@link withDeadline}, wrapped around each
   * `publisher.publish` call below, is what actually bounds that: a
   * publish that outlives {@link PER_ROW_PUBLISH_BUDGET_MS} becomes an
   * ordinary recorded failure for that one row instead of a promise that
   * never settles.
   *
   * Parsing each row's raw payload into an {@link EventEnvelope} also
   * happens inside this same per-row `try` — never inside
   * `OutboxRepository.claimBatch` — so that an unparseable payload (an
   * `eventType` this worker's schema no longer recognises, most likely
   * from a rolling deploy landing the API ahead of the worker) fails only
   * that row, the same way a rejected publish does, rather than escaping
   * the transaction and aborting the whole batch.
   */
  async runOnce(): Promise<RunOnceResult> {
    const failures: FailedRow[] = [];
    let published = 0;

    await this.prisma.$transaction(
      async (tx) => {
        const rows = await this.repository.claimBatch(tx, this.config.batchSize, this.config.maxAttempts);

        for (const row of rows) {
          let envelope: EventEnvelope;
          try {
            envelope = parseEnvelope(row.payload);
            await withDeadline(
              this.publisher.publish(envelope),
              PER_ROW_PUBLISH_BUDGET_MS,
              `outbox relay: publish did not confirm within ${PER_ROW_PUBLISH_BUDGET_MS}ms`,
            );
          } catch (error) {
            failures.push({ id: row.id, error: error instanceof Error ? error : new Error(String(error)) });
            continue;
          }

          await this.repository.markPublished(tx, row.id);
          published += 1;
          forEvent({ eventId: envelope.eventId, reviewId: envelope.payload.reviewId }).info(
            `outbox relay: published event ${envelope.eventId} (${envelope.eventType})`,
          );
        }
      },
      { timeout: this.config.batchSize * PER_ROW_PUBLISH_BUDGET_MS + TRANSACTION_TIMEOUT_HEADROOM_MS },
    );

    for (const failure of failures) {
      const attempts = await this.repository.recordFailure(failure.id, failure.error.message);
      if (attempts >= this.config.maxAttempts) {
        this.logger.error(
          `outbox relay: parking row ${failure.id} after ${attempts} attempts: ${failure.error.message}`,
        );
      } else {
        this.logger.warn(
          `outbox relay: row ${failure.id} failed to publish (attempt ${attempts}/${this.config.maxAttempts}): ${failure.error.message}`,
        );
      }
    }

    return { published, failed: failures.length };
  }
}

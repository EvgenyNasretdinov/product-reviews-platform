import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { PrismaClient } from '@reviews/db';
import type { EventPublisher } from '../messaging/event.publisher.js';
import { OutboxRepository } from './outbox.repository.js';

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
 * Worst-case per-row budget for the batch transaction's timeout, in
 * milliseconds. A healthy confirm round-trip is single digits of
 * milliseconds; this budgets two orders of magnitude worse — a slow or
 * backpressured broker — for every row in the batch. Deliberately
 * generous rather than tight: a relay that silently fails whole batches
 * because nobody sized the timeout is a worse failure mode than one that
 * occasionally runs a little long.
 */
const PER_ROW_PUBLISH_BUDGET_MS = 200;

/**
 * Fixed addition to the batch transaction's timeout, covering overhead
 * that doesn't scale with batch size: acquiring a pool connection,
 * Postgres planning the claim query, committing.
 */
const TRANSACTION_TIMEOUT_HEADROOM_MS = 2_000;

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
export class OutboxRelayService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxRelayService.name);
  private timer: NodeJS.Timeout | undefined;
  private inFlight = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly publisher: EventPublisher,
    private readonly repository: OutboxRepository,
    private readonly config: OutboxRelayConfig,
  ) {}

  onApplicationBootstrap(): void {
    this.start();
  }

  onApplicationShutdown(): void {
    this.stop();
  }

  /** Starts the polling loop. A no-op if already started. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.pollIntervalMs);
    // Never keep the process alive on its own — only real work should.
    this.timer.unref();
  }

  /** Stops the polling loop. A no-op if already stopped. */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * One interval tick. Guarded by `inFlight` so a batch that runs longer
   * than `pollIntervalMs` cannot stack a second call behind it — without
   * this, a slow batch (a sluggish broker, a large backlog) would pile up
   * concurrent `runOnce` calls against the same instance, each claiming
   * whatever the others left, for no benefit over just letting one run to
   * completion and starting the next tick after.
   */
  private async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error('outbox relay: poll failed', error instanceof Error ? error.stack : String(error));
    } finally {
      this.inFlight = false;
    }
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
   * a slow broker makes it fail outright.
   */
  async runOnce(): Promise<RunOnceResult> {
    const failures: FailedRow[] = [];
    let published = 0;

    await this.prisma.$transaction(
      async (tx) => {
        const rows = await this.repository.claimBatch(tx, this.config.batchSize, this.config.maxAttempts);

        for (const row of rows) {
          try {
            await this.publisher.publish(row.envelope);
          } catch (error) {
            failures.push({ id: row.id, error: error instanceof Error ? error : new Error(String(error)) });
            continue;
          }

          await this.repository.markPublished(tx, row.id);
          published += 1;
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

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
   * The whole claim-publish-mark sequence for the batch runs in one
   * transaction, so a row's lock (via `FOR UPDATE SKIP LOCKED`) is held
   * only as long as the transaction is open. A row that fails to publish
   * does **not** abort that transaction — its failure is caught, and the
   * loop moves on to the rest of the batch — because rolling back the
   * whole transaction over one bad row would also roll back every
   * successful publish committed beside it. Failures are instead recorded
   * afterwards, each in {@link OutboxRepository.recordFailure}'s own
   * transaction. A failure in `markPublished` itself is different and
   * deliberately *not* caught: that is a failure of the durable record of
   * a publish that already happened, and the only safe response is to
   * roll back and let the row be republished next time — at-least-once,
   * not exactly-once.
   */
  async runOnce(): Promise<RunOnceResult> {
    const failures: FailedRow[] = [];
    let published = 0;

    await this.prisma.$transaction(async (tx) => {
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
    });

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

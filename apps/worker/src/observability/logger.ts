import pino, { type Logger as PinoLogger } from 'pino';

/**
 * The worker's structured logger, shared by the outbox relay and both
 * consumers.
 *
 * Everywhere the pipeline logs something about one specific event — the
 * relay publishing a row, `registerConsumer` acking or dead-lettering a
 * delivery — it does so through {@link forEvent}, a child of this logger
 * carrying `eventId`, `queue`, and `reviewId` as structured fields rather
 * than interpolated into the message text. That is what makes one review
 * traceable end to end: `grep '"reviewId":"<id>"'` (or the equivalent
 * query in whatever aggregates this worker's stdout) finds every line
 * about it — the relay publishing its `review.submitted` event, the
 * moderation consumer processing that delivery, and later the aggregation
 * consumer processing whatever `review.approved`/`review.flagged`/
 * `review.rejected` event the decision produced — without needing to
 * parse each message's prose to find the id buried in it.
 *
 * `LOG_LEVEL` is read directly from `process.env` rather than threaded
 * through `AppEnv`/`envSchema`: logging configuration is operational, not
 * part of what makes a boot valid or invalid, so an unset or nonsense
 * value has a safe default (`'info'`) instead of failing startup the way
 * a bad `DATABASE_URL` should.
 */
export const logger: PinoLogger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
});

/** The standard fields a pipeline log line carries — see the module doc comment for why these three specifically. */
export interface PipelineLogContext {
  eventId?: string;
  queue?: string;
  reviewId?: string;
}

/**
 * A child of {@link logger} scoped to one event: `context`'s fields are
 * attached to every line logged through the returned logger, as JSON
 * fields, not folded into the message string. Call sites should prefer
 * this over the root `logger` whenever an `eventId` or `reviewId` is on
 * hand — see `messaging/consumer.base.ts` and
 * `relay/outbox-relay.service.ts` for the two call sites this exists for.
 */
export function forEvent(context: PipelineLogContext): PinoLogger {
  return logger.child(context);
}

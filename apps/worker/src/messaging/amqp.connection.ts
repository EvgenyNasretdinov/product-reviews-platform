import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import amqplib, { type ChannelModel, type ConfirmChannel } from 'amqplib';
import type { AppEnv } from '../config/env.js';
import { assertTopology } from './topology.js';

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
// After this many consecutive failed reconnect attempts, every further
// attempt logs at error instead of warn: loud enough that an operator
// tailing logs sees an escalating problem, not one warning line from
// seventeen minutes ago.
const LOUD_LOG_THRESHOLD = 3;

/**
 * The exponential reconnect backoff, capped at `MAX_RECONNECT_DELAY_MS` so
 * a long outage doesn't mean an ever-growing gap between attempts. A pure
 * function so its shape is testable without a broker or a real timer.
 */
export function computeReconnectDelayMs(attempt: number): number {
  return Math.min(INITIAL_RECONNECT_DELAY_MS * 2 ** attempt, MAX_RECONNECT_DELAY_MS);
}

/**
 * Opens a fresh AMQP connection. Defaults to `amqplib.connect`; overridable
 * (see `AmqpConnection`'s constructor) so the reconnect loop is exercisable
 * in a unit test with a fake broker instead of a real one.
 */
export type AmqpOpener = (url: string) => Promise<ChannelModel>;

/** Renders an unknown rejection reason as a log-safe string without risking `[object Object]` from a bare `String(value)`. */
function describeError(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return 'unserializable error value';
  }
}

/**
 * Owns the single AMQP connection and its confirm channel for this
 * process. Consumers of the channel (see {@link EventPublisher} and, in
 * later tasks, the moderation/aggregation consumers) call
 * {@link getChannel} on every use rather than caching the return value,
 * because a reconnect after a dropped connection replaces the channel
 * instance — a cached reference would silently go stale.
 *
 * `assertTopology` runs on every successful connect, not just the first
 * one: a reconnect after a broker restart must re-declare the topology
 * too, in case the restart came with a clean broker.
 *
 * A broker outage is retried forever, not abandoned after a fixed number
 * of attempts. This process has no HTTP surface for an orchestrator's
 * healthcheck to fail on, and nothing today restarts it on its own (that
 * arrives with Plan 3's Compose work) — a worker that gave up would stop
 * publishing permanently until a human happened to notice. The backoff
 * still caps at `MAX_RECONNECT_DELAY_MS`, and logging escalates to error
 * level once a handful of attempts have failed in a row, so the outage is
 * loud in the logs even though the process itself keeps trying quietly.
 *
 * Deliberately *not* `OnModuleDestroy`: Nest runs every provider's
 * `onModuleDestroy` before any provider's `onApplicationShutdown` (see
 * `NestApplicationContext#close`), so a hook here would close the channel
 * and connection before the relay had stopped or the consumers had
 * drained their in-flight deliveries — exactly backwards from the order
 * Task 6's graceful shutdown needs. `close()` is a plain method instead,
 * called explicitly, last, by `AppModule`'s shutdown orchestrator.
 */
@Injectable()
export class AmqpConnection implements OnModuleInit {
  private readonly logger = new Logger(AmqpConnection.name);
  private connectionModel: ChannelModel | undefined;
  private channel: ConfirmChannel | undefined;
  private reconnectAttempts = 0;
  private disconnectedAt: number | undefined;
  private shuttingDown = false;

  constructor(
    private readonly env: AppEnv,
    private readonly open: AmqpOpener = amqplib.connect,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.connect();
  }

  /** Closes the channel and connection and stops reconnecting. See the class doc comment for why this isn't an `OnModuleDestroy` hook. */
  async close(): Promise<void> {
    this.shuttingDown = true;
    await this.channel?.close().catch(() => undefined);
    await this.connectionModel?.close().catch(() => undefined);
    this.channel = undefined;
    this.connectionModel = undefined;
  }

  /**
   * The current live confirm channel. Throws if called before the first
   * successful connect, or while a reconnect is in flight — callers that
   * publish or consume should let that failure surface rather than queue
   * work against a channel that doesn't exist yet.
   */
  getChannel(): ConfirmChannel {
    if (!this.channel) {
      throw new Error('AmqpConnection: no live channel (not connected yet, or reconnecting)');
    }
    return this.channel;
  }

  private async connect(): Promise<void> {
    const connectionModel = await this.open(this.env.rabbitmqUrl);
    const channel = await connectionModel.createConfirmChannel();
    await assertTopology(channel);

    this.connectionModel = connectionModel;
    this.channel = channel;
    this.reconnectAttempts = 0;
    this.disconnectedAt = undefined;

    connectionModel.on('error', (error: Error) => {
      this.logger.error(`AMQP connection error: ${error.message}`);
    });
    connectionModel.on('close', () => {
      this.channel = undefined;
      this.connectionModel = undefined;
      if (this.shuttingDown) return;
      this.disconnectedAt ??= Date.now();
      this.logger.warn('AMQP connection closed; scheduling reconnect');
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    const delay = computeReconnectDelayMs(this.reconnectAttempts);
    this.reconnectAttempts += 1;
    const attempt = this.reconnectAttempts;

    setTimeout(() => {
      this.connect().catch((error: unknown) => {
        const elapsedMs = this.disconnectedAt !== undefined ? Date.now() - this.disconnectedAt : 0;
        const nextDelay = computeReconnectDelayMs(attempt);
        if (attempt > LOUD_LOG_THRESHOLD) {
          this.logger.error(
            `AMQP still disconnected after ${attempt} attempts (${elapsedMs}ms elapsed); retrying in ${nextDelay}ms`,
            describeError(error),
          );
        } else {
          this.logger.warn(`AMQP reconnect attempt ${attempt} failed; retrying in ${nextDelay}ms: ${describeError(error)}`);
        }
        this.scheduleReconnect();
      });
    }, delay);
  }
}

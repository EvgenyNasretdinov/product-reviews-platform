import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import amqplib, { type ChannelModel, type ConfirmChannel } from 'amqplib';
import { APP_ENV } from '../config/config.module.js';
import type { AppEnv } from '../config/env.js';
import { assertTopology } from './topology.js';

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 10;

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
 */
@Injectable()
export class AmqpConnection implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AmqpConnection.name);
  private connectionModel: ChannelModel | undefined;
  private channel: ConfirmChannel | undefined;
  private reconnectAttempts = 0;
  private shuttingDown = false;

  constructor(@Inject(APP_ENV) private readonly env: AppEnv) {}

  async onModuleInit(): Promise<void> {
    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
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
    const connectionModel = await amqplib.connect(this.env.rabbitmqUrl);
    const channel = await connectionModel.createConfirmChannel();
    await assertTopology(channel);

    this.connectionModel = connectionModel;
    this.channel = channel;
    this.reconnectAttempts = 0;

    connectionModel.on('error', (error: Error) => {
      this.logger.error(`AMQP connection error: ${error.message}`);
    });
    connectionModel.on('close', () => {
      this.channel = undefined;
      this.connectionModel = undefined;
      if (this.shuttingDown) return;
      this.logger.warn('AMQP connection closed; scheduling reconnect');
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.logger.error(`AMQP reconnect gave up after ${MAX_RECONNECT_ATTEMPTS} attempts`);
      return;
    }

    const delay = Math.min(INITIAL_RECONNECT_DELAY_MS * 2 ** this.reconnectAttempts, MAX_RECONNECT_DELAY_MS);
    this.reconnectAttempts += 1;

    setTimeout(() => {
      this.connect().catch((error: unknown) => {
        this.logger.error(
          `AMQP reconnect attempt ${this.reconnectAttempts} failed`,
          error instanceof Error ? error.stack : error,
        );
        this.scheduleReconnect();
      });
    }, delay);
  }
}

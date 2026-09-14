import { EventEmitter } from 'node:events';
import type { ChannelModel, ConfirmChannel } from 'amqplib';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../config/env.js';
import { AmqpConnection, computeReconnectDelayMs, type AmqpOpener } from './amqp.connection.js';

const fakeEnv: AppEnv = {
  nodeEnv: 'test',
  databaseUrl: 'postgresql://fake-host-never-dialed/db',
  rabbitmqUrl: 'amqp://fake-host-never-dialed',
  outboxBatchSize: 50,
  outboxMaxAttempts: 5,
  outboxPollIntervalMs: 500,
  redisUrl: 'redis://fake-host-never-dialed:6379',
};

function makeFakeChannel(): ConfirmChannel {
  return {
    assertExchange: vi.fn().mockResolvedValue({ exchange: 'x' }),
    assertQueue: vi.fn().mockResolvedValue({ queue: 'q', messageCount: 0, consumerCount: 0 }),
    bindQueue: vi.fn().mockResolvedValue({}),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as ConfirmChannel;
}

/**
 * A minimal stand-in for amqplib's `ChannelModel`: an EventEmitter (so
 * tests can fire 'close') plus the methods `AmqpConnection` calls on it.
 * `closeMock` exposes the close spy as a plain property rather than a
 * method the caller would reference unbound (`model.close`), which is
 * what `@typescript-eslint/unbound-method` warns about.
 */
interface FakeChannelModel extends ChannelModel {
  closeMock: ReturnType<typeof vi.fn>;
}

function makeFakeChannelModel(): FakeChannelModel {
  const emitter = new EventEmitter();
  const closeMock = vi.fn().mockResolvedValue(undefined);
  return Object.assign(emitter, {
    createConfirmChannel: vi.fn().mockResolvedValue(makeFakeChannel()),
    close: closeMock,
    closeMock,
  }) as unknown as FakeChannelModel;
}

describe('computeReconnectDelayMs', () => {
  it('grows exponentially from the initial delay', () => {
    expect(computeReconnectDelayMs(0)).toBe(1_000);
    expect(computeReconnectDelayMs(1)).toBe(2_000);
    expect(computeReconnectDelayMs(2)).toBe(4_000);
  });

  it('caps at 30 seconds no matter how many attempts have elapsed', () => {
    expect(computeReconnectDelayMs(10)).toBe(30_000);
    expect(computeReconnectDelayMs(50)).toBe(30_000);
  });
});

describe('AmqpConnection', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('throws from getChannel before the first successful connect', () => {
    const connection = new AmqpConnection(fakeEnv, vi.fn());
    expect(() => connection.getChannel()).toThrow(/no live channel/);
  });

  it('keeps retrying past the old ten-attempt cap until the broker comes back', async () => {
    vi.useFakeTimers();
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const firstModel = makeFakeChannelModel();
    const secondModel = makeFakeChannelModel();
    let callCount = 0;
    // Attempt 1 (the initial connect) succeeds; attempts 2-16 (15 failures,
    // more than the old MAX_RECONNECT_ATTEMPTS of 10) fail; attempt 17
    // succeeds. A worker that gives up after 10 attempts would never reach
    // attempt 17.
    const open: AmqpOpener = vi.fn(() => {
      callCount += 1;
      if (callCount === 1) return Promise.resolve(firstModel);
      if (callCount <= 16) return Promise.reject(new Error(`broker unreachable (attempt ${callCount})`));
      return Promise.resolve(secondModel);
    });

    const connection = new AmqpConnection(fakeEnv, open);
    await connection.onModuleInit();
    expect(connection.getChannel()).toBeDefined();

    firstModel.emit('close');
    expect(() => connection.getChannel()).toThrow();

    for (let i = 0; i < 25; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
    }

    expect(callCount).toBeGreaterThan(16);
    expect(connection.getChannel()).toBeDefined();
  });

  it('escalates to error-level logs with the attempt count and elapsed time once retries pass the first few', async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const firstModel = makeFakeChannelModel();
    let calls = 0;
    // First call succeeds so there is a live connection to drop; every
    // call after that fails, so the retry loop never gives up on its own.
    const open: AmqpOpener = vi.fn(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve(firstModel);
      return Promise.reject(new Error('still down'));
    });

    const connection = new AmqpConnection(fakeEnv, open);
    await connection.onModuleInit();
    firstModel.emit('close');

    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
    }

    const escalatingCalls = errorSpy.mock.calls.filter(
      ([message]) => typeof message === 'string' && /attempt/.test(message) && /elapsed/.test(message),
    );
    expect(escalatingCalls.length).toBeGreaterThan(0);
  });

  it('close() closes the channel and connection and does not reconnect', async () => {
    const model = makeFakeChannelModel();
    const open: AmqpOpener = vi.fn(() => Promise.resolve(model));
    const connection = new AmqpConnection(fakeEnv, open);
    await connection.onModuleInit();

    await connection.close();

    expect(model.closeMock).toHaveBeenCalledTimes(1);
    expect(() => connection.getChannel()).toThrow();
  });
});

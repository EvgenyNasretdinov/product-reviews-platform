import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const valid = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  RABBITMQ_URL: 'amqp://guest:guest@localhost:5672',
  REDIS_URL: 'redis://localhost:6379',
};

describe('loadEnv', () => {
  it('parses a valid environment and defaults every outbox tuning variable', () => {
    const env = loadEnv(valid);
    expect(env.databaseUrl).toBe(valid.DATABASE_URL);
    expect(env.rabbitmqUrl).toBe(valid.RABBITMQ_URL);
    expect(env.redisUrl).toBe(valid.REDIS_URL);
    expect(env.outboxBatchSize).toBe(20);
    expect(env.outboxMaxAttempts).toBe(5);
    expect(env.outboxPollIntervalMs).toBe(500);
  });

  it('coerces the outbox tuning variables from strings', () => {
    const env = loadEnv({ ...valid, OUTBOX_BATCH_SIZE: '50', OUTBOX_MAX_ATTEMPTS: '3', OUTBOX_POLL_INTERVAL_MS: '1000' });
    expect(env.outboxBatchSize).toBe(50);
    expect(env.outboxMaxAttempts).toBe(3);
    expect(env.outboxPollIntervalMs).toBe(1000);
  });

  it('rejects a DATABASE_URL that is not a URL', () => {
    expect(() => loadEnv({ ...valid, DATABASE_URL: 'not-a-url' })).toThrow(/DATABASE_URL/);
  });

  it('rejects a non-positive OUTBOX_BATCH_SIZE', () => {
    expect(() => loadEnv({ ...valid, OUTBOX_BATCH_SIZE: '0' })).toThrow(/OUTBOX_BATCH_SIZE/);
  });

  it('rejects a non-integer OUTBOX_MAX_ATTEMPTS', () => {
    expect(() => loadEnv({ ...valid, OUTBOX_MAX_ATTEMPTS: '2.5' })).toThrow(/OUTBOX_MAX_ATTEMPTS/);
  });

  it('reports every invalid variable at once', () => {
    expect(() => loadEnv({ ...valid, RABBITMQ_URL: 'nope', REDIS_URL: 'also-nope' })).toThrow(
      /RABBITMQ_URL[\s\S]*REDIS_URL/,
    );
  });
});

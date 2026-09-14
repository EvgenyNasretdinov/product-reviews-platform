import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants.js';
import { CacheService } from './cache.service.js';

// How many keys SCAN is asked to examine per round trip. This is a hint,
// not a hard limit — Redis may return more or fewer — so it only bounds how
// chunky each round trip is, not how many rounds a large prefix takes.
const SCAN_COUNT_HINT = 500;

/**
 * `CacheService` backed by the shared ioredis client from `RedisModule`
 * (the same connection the readiness probe pings) rather than a second,
 * independently configured client.
 */
@Injectable()
export class RedisCacheService extends CacheService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {
    super();
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key);
    if (raw === null) {
      return null;
    }
    return JSON.parse(raw) as T;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    await this.redis.del(...keys);
  }

  /**
   * Deletes every key matching `${prefix}*` by walking the keyspace with
   * `SCAN` in small batches, never with `KEYS`. `KEYS` walks the *entire*
   * keyspace in one blocking pass — Redis is single-threaded, so on a
   * production-sized keyspace that pass blocks every other client for its
   * duration, which is an outage, not a slow query. `SCAN` returns a cursor
   * and a small batch each call, interleaved with other commands, at the
   * cost of a weaker isolation guarantee (a key added or removed mid-scan
   * may or may not be seen) that doesn't matter for invalidating a stale
   * prefix — this is not trying to take a consistent snapshot of it.
   *
   * The one-liner `KEYS ${prefix}* | DEL` will look tempting to a future
   * editor because it's shorter and this method isn't on any hot path
   * today: resist it, because the day it matters is the day this runs
   * against a keyspace large enough for the blocking pass to hurt.
   */
  async delByPrefix(prefix: string): Promise<void> {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', SCAN_COUNT_HINT);
      cursor = nextCursor;
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } while (cursor !== '0');
  }
}

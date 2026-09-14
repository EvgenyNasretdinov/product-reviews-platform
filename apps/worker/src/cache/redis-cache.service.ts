import { Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { CacheService } from './cache.service.js';

// How many keys SCAN is asked to examine per round trip. This is a hint,
// not a hard limit — Redis may return more or fewer — so it only bounds how
// chunky each round trip is, not how many rounds a large prefix takes.
const SCAN_COUNT_HINT = 500;

/**
 * `CacheService` backed by a plain ioredis client.
 *
 * A byte-for-byte port of `apps/api/src/common/cache/redis-cache.service.ts`
 * (see `cache.service.ts`'s doc comment for why this worker keeps its own
 * copy instead of importing the API's). `delByPrefix` walks the keyspace
 * with `SCAN` in small batches, never `KEYS` — see the API's copy for the
 * full reasoning: `KEYS` blocks the single-threaded server for the whole
 * keyspace, `SCAN` doesn't, at the cost of an isolation guarantee that
 * doesn't matter for invalidating a stale prefix.
 */
@Injectable()
export class RedisCacheService extends CacheService {
  constructor(private readonly redis: Redis) {
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

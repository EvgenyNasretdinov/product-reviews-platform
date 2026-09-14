import { Injectable } from '@nestjs/common';
import { CacheService } from './cache.service.js';

interface Entry {
  value: unknown;
  expiresAt: number;
}

/**
 * In-process `CacheService`, backed by a `Map` with per-entry expiry
 * checked on read (there is no background sweep — an expired entry simply
 * looks like a miss the next time it's read, and is deleted then).
 *
 * This is what lets a suite that isn't testing caching itself exercise
 * `ProductsService`'s cache-aside path with no Redis container: bind
 * `CacheService` to an instance of this class in the test module instead of
 * `RedisCacheService`. It's also the production fallback `CacheModule`
 * picks when no Redis connection is configured.
 */
@Injectable()
export class MemoryCacheService extends CacheService {
  private readonly store = new Map<string, Entry>();

  // These methods are declared `Promise`-returning to satisfy the
  // `CacheService` port (every real backend, i.e. Redis, is genuinely
  // asynchronous), but this one never actually awaits anything — it's a
  // synchronous `Map` underneath. `async` bodies with no `await` trip
  // `@typescript-eslint/require-await`, so the return values are wrapped
  // in `Promise.resolve` explicitly instead of marking these `async`.

  get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) {
      return Promise.resolve(null);
    }
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return Promise.resolve(null);
    }
    return Promise.resolve(entry.value as T);
  }

  set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    return Promise.resolve();
  }

  del(...keys: string[]): Promise<void> {
    for (const key of keys) {
      this.store.delete(key);
    }
    return Promise.resolve();
  }

  delByPrefix(prefix: string): Promise<void> {
    // Collect first, then delete: mutating a Map while iterating it is
    // spec-safe for `Map`, but collecting keeps this method's behaviour
    // obviously correct without relying on that guarantee.
    const matching = [...this.store.keys()].filter((key) => key.startsWith(prefix));
    for (const key of matching) {
      this.store.delete(key);
    }
    return Promise.resolve();
  }
}

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryCacheService } from './memory-cache.service.js';

describe('MemoryCacheService', () => {
  let cache: MemoryCacheService;

  beforeEach(() => {
    cache = new MemoryCacheService();
  });

  it('returns null for a missing key', async () => {
    await expect(cache.get('missing')).resolves.toBeNull();
  });

  it('round-trips an object through set then get', async () => {
    const value = { id: 'abc-123', reviewCount: 4, distribution: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 3 } };

    await cache.set('key', value, 60);

    await expect(cache.get('key')).resolves.toEqual(value);
  });

  it('expires a value once its TTL has elapsed', async () => {
    vi.useFakeTimers();
    try {
      await cache.set('key', 'value', 10);
      expect(await cache.get('key')).toBe('value');

      vi.advanceTimersByTime(10_001);

      await expect(cache.get('key')).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes only the specific keys passed to del', async () => {
    await cache.set('keep', 'a', 60);
    await cache.set('drop', 'b', 60);

    await cache.del('drop');

    expect(await cache.get('keep')).toBe('a');
    expect(await cache.get('drop')).toBeNull();
  });

  it('delByPrefix removes matching keys and leaves the rest', async () => {
    await cache.set('product:1:reviews:newest:all', 'x', 60);
    await cache.set('product:1:reviews:helpful:all', 'y', 60);
    await cache.set('product:2:reviews:newest:all', 'z', 60);

    await cache.delByPrefix('product:1:reviews:');

    expect(await cache.get('product:1:reviews:newest:all')).toBeNull();
    expect(await cache.get('product:1:reviews:helpful:all')).toBeNull();
    expect(await cache.get('product:2:reviews:newest:all')).toBe('z');
  });
});

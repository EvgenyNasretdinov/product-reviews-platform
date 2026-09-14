/**
 * The cache-aside port every feature reads and writes through.
 *
 * This is an abstract class, not an interface, specifically so it can also
 * serve as a Nest DI token (`@Inject(CacheService)` / constructor typing
 * both work off the same symbol) — an interface has no runtime value to
 * provide against. `CacheModule` binds it to either `RedisCacheService` or
 * `MemoryCacheService`; nothing outside that module ever imports a concrete
 * implementation, which is what lets a suite that isn't testing caching
 * itself run against `MemoryCacheService` with no Redis container.
 */
export abstract class CacheService {
  abstract get<T>(key: string): Promise<T | null>;
  abstract set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  abstract del(...keys: string[]): Promise<void>;
  abstract delByPrefix(prefix: string): Promise<void>;
}

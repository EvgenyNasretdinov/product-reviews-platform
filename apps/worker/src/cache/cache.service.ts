/**
 * The cache-aside port this worker invalidates through.
 *
 * Mirrors `apps/api/src/common/cache/cache.service.ts` exactly in shape —
 * `get`/`set`/`del`/`delByPrefix` — but is its own copy rather than a
 * shared import: this worker cannot depend on `apps/api` (see
 * `packages/contracts/src/cache-keys.ts`'s doc comment for why the key
 * builders themselves live in `@reviews/contracts` instead of there, for
 * exactly this reason), and the port has no business logic worth
 * extracting into a shared package on its own. An abstract class, not an
 * interface, so it can double as a Nest DI token the way `apps/api`'s does.
 */
export abstract class CacheService {
  abstract get<T>(key: string): Promise<T | null>;
  abstract set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  abstract del(...keys: string[]): Promise<void>;
  abstract delByPrefix(prefix: string): Promise<void>;
}

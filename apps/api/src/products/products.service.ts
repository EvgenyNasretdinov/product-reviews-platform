import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { cacheKeys, paginatedSchema, productDetailDtoSchema, TTL_PRODUCT_DETAIL, type ProductDetailDto } from '@reviews/contracts';
import type { z } from 'zod';
import { CacheService } from '../common/cache/cache.service.js';
import { decodeCursor, encodeCursor } from '../common/pagination/cursor.js';
import { toProductDetailDto } from './products.mapper.js';
import { ProductsRepository } from './products.repository.js';

/** The cursor scope for the product list — see cursor.ts for why a cursor is scoped at all. */
const CURSOR_SCOPE = 'products';

export interface ListProductsQuery {
  q?: string;
  cursor?: string;
  limit: number;
}

// Derived from the shared contract rather than hand-restated: if
// `paginatedSchema`'s field names ever change (e.g. `nextCursor` renamed),
// this type — and every call site that builds one — fails to compile
// instead of silently drifting from what the contract actually promises.
export const productListSchema = paginatedSchema(productDetailDtoSchema);
export type ListProductsResult = z.infer<typeof productListSchema>;

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    private readonly repository: ProductsRepository,
    private readonly cache: CacheService,
  ) {}

  async list(query: ListProductsQuery): Promise<ListProductsResult> {
    const cursor = query.cursor ? decodeCursor(query.cursor, CURSOR_SCOPE) : undefined;
    const { rows, hasMore } = await this.repository.list({ q: query.q, limit: query.limit, cursor });

    const items = rows.map(toProductDetailDto);
    const last = rows.at(-1);
    const nextCursor = hasMore && last ? encodeCursor(last.createdAt.toISOString(), last.id, CURSOR_SCOPE) : null;

    return { items, nextCursor };
  }

  /**
   * Cache-aside: a hit returns the cached DTO without touching Postgres; a
   * miss computes it from the repository and writes it back before
   * returning. This is the hottest read in the catalogue — a product page
   * — and it changes only when moderation publishes a review, so serving a
   * `TTL_PRODUCT_DETAIL`-second-stale copy is the right trade, not a bug.
   *
   * The cache read and write are both guarded: a cache is an optional
   * accelerator, and `RedisModule` deliberately sets `maxRetriesPerRequest:
   * 1` so a hung Redis fails fast rather than hanging the request — but
   * "fails fast" still means it *throws*. Left unguarded, a transient Redis
   * blip (not even a full outage) would 500 the single hottest read route
   * in the catalogue even though Postgres is perfectly capable of serving
   * it. Catching here and falling through to the repository is what keeps
   * the cache a strict improvement over no cache, never a regression from
   * it — see `test/cache.integration.test.ts`'s "serves the product from
   * Postgres when Redis is unreachable" case for the proof.
   */
  async getBySlug(slug: string): Promise<ProductDetailDto> {
    const key = cacheKeys.productDetail(slug);
    const cached = await this.safeCacheGet<ProductDetailDto>(key);
    if (cached !== null) {
      return cached;
    }

    const row = await this.repository.findBySlug(slug);
    if (!row) {
      throw new NotFoundException('Product not found');
    }
    const dto = toProductDetailDto(row);
    await this.safeCacheSet(key, dto, TTL_PRODUCT_DETAIL);
    return dto;
  }

  private async safeCacheGet<T>(key: string): Promise<T | null> {
    try {
      return await this.cache.get<T>(key);
    } catch (error) {
      this.logCacheFailure('read', key, error);
      return null;
    }
  }

  private async safeCacheSet<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    try {
      await this.cache.set(key, value, ttlSeconds);
    } catch (error) {
      this.logCacheFailure('write', key, error);
    }
  }

  private logCacheFailure(operation: 'read' | 'write', key: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.warn(`Cache ${operation} failed for "${key}", falling through to Postgres: ${message}`);
  }
}

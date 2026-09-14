import { Injectable, NotFoundException } from '@nestjs/common';
import type { ProductDetailDto } from '@reviews/contracts';
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

export interface ListProductsResult {
  items: ProductDetailDto[];
  nextCursor: string | null;
}

@Injectable()
export class ProductsService {
  constructor(private readonly repository: ProductsRepository) {}

  async list(query: ListProductsQuery): Promise<ListProductsResult> {
    const cursor = query.cursor ? decodeCursor(query.cursor, CURSOR_SCOPE) : undefined;
    const { rows, hasMore } = await this.repository.list({ q: query.q, limit: query.limit, cursor });

    const items = rows.map(toProductDetailDto);
    const last = rows.at(-1);
    const nextCursor = hasMore && last ? encodeCursor(last.createdAt.toISOString(), last.id, CURSOR_SCOPE) : null;

    return { items, nextCursor };
  }

  async getBySlug(slug: string): Promise<ProductDetailDto> {
    const row = await this.repository.findBySlug(slug);
    if (!row) {
      throw new NotFoundException('Product not found');
    }
    return toProductDetailDto(row);
  }
}

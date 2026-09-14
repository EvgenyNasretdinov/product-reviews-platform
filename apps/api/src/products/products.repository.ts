import { Injectable } from '@nestjs/common';
import type { Prisma, Product, ProductRatingSummary } from '@reviews/db';
import { parseCursorDate } from '../common/pagination/cursor.js';
import { PrismaService } from '../common/prisma/prisma.service.js';

/** A product row joined with its (possibly absent) materialised rating summary. */
export type ProductWithSummary = Product & { ratingSummary: ProductRatingSummary | null };

export interface ListProductsParams {
  q?: string;
  limit: number;
  cursor?: { key: string; id: string };
}

export interface ListProductsPage {
  /** At most `limit` rows — the lookahead row used to compute `hasMore` is trimmed off. */
  rows: ProductWithSummary[];
  hasMore: boolean;
}

/**
 * Owns every Prisma call the catalogue makes. `ProductsService` and
 * `ProductsController` never see a Prisma type.
 */
@Injectable()
export class ProductsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Keyset pagination: fetches `limit + 1` rows ordered by
   * `createdAt DESC, id DESC` so the caller can tell whether a next page
   * exists without a second `COUNT` query — the extra row is trimmed here
   * before the rows are returned.
   *
   * The search filter and the cursor filter are combined with `AND` rather
   * than merged into a single object literal with two `OR` keys (as a
   * naive reading of "OR for search, OR for cursor" might suggest): a
   * plain object can only hold one `OR` key, so spreading both into the
   * same literal would silently let the second overwrite the first once a
   * request carries both `q` and `cursor` — dropping the search filter on
   * every page after the first. test/products.integration.test.ts covers
   * exactly this combination ("keeps the q filter applied on a second page
   * fetched with a cursor"), which fails against the spread-`OR` form and
   * passes against this one.
   */
  async list(params: ListProductsParams): Promise<ListProductsPage> {
    const { q, limit, cursor } = params;

    const conditions: Prisma.ProductWhereInput[] = [];
    if (q) {
      conditions.push({
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
        ],
      });
    }
    if (cursor) {
      // Unvalidated, `new Date(cursor.key)` on a malformed key produces an
      // Invalid Date that reaches Prisma's serialiser and throws
      // `RangeError: Invalid time value` — not an `HttpException`, not a
      // Prisma error, so it falls through the global exception filter to a
      // 500 on this public, unauthenticated endpoint. `parseCursorDate`
      // rejects it as a 400 instead — see its doc comment in cursor.ts, and
      // `ReviewsRepository.listApproved`'s identical use for the reference
      // case this was carried over from.
      const cursorDate = parseCursorDate(cursor.key);
      conditions.push({
        OR: [{ createdAt: { lt: cursorDate } }, { createdAt: cursorDate, id: { lt: cursor.id } }],
      });
    }
    const where: Prisma.ProductWhereInput = conditions.length > 0 ? { AND: conditions } : {};

    const rows = await this.prisma.product.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: { ratingSummary: true },
    });

    const hasMore = rows.length > limit;
    return { rows: hasMore ? rows.slice(0, limit) : rows, hasMore };
  }

  async findBySlug(slug: string): Promise<ProductWithSummary | null> {
    return this.prisma.product.findUnique({
      where: { slug },
      include: { ratingSummary: true },
    });
  }
}

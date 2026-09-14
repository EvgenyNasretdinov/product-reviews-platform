import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import type { ProductDetailDto } from '@reviews/contracts';
import { z } from 'zod';
import { Public } from '../auth/decorators/public.decorator.js';
import { ProductsService, type ListProductsResult } from './products.service.js';

/**
 * `limit` is validated by hand through this schema rather than Nest's
 * class-validator `ValidationPipe`: the global pipe skips plain-object
 * query params with no class-validator metatype (see AuthController's
 * `@Body() body: unknown` for the same pattern on the login route), so a
 * bare `@Query() query: unknown` reaches the handler unvalidated and this
 * schema is what actually enforces "integer, 1-100, default 20".
 */
const listProductsQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

@Public()
@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  async list(@Query() query: unknown): Promise<ListProductsResult> {
    const parsed = listProductsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((issue) => issue.message).join('; '));
    }
    return this.productsService.list(parsed.data);
  }

  @Get(':slug')
  async detail(@Param('slug') slug: string): Promise<ProductDetailDto> {
    return this.productsService.getBySlug(slug);
  }
}

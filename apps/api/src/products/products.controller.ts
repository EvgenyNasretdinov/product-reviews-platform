import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { ProductDetailDto } from '@reviews/contracts';
import { z } from 'zod';
import { Public } from '../auth/decorators/public.decorator.js';
import { ErrorResponseDto } from '../common/openapi/error-response.dto.js';
import { ProductDetailResponseDto, ProductListResponseDto } from './dto/products.dto.js';
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

@ApiTags('products')
@Public()
@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  @ApiOperation({ summary: 'Search the product catalogue' })
  @ApiQuery({ name: 'q', required: false, type: String, description: 'Free-text search term.' })
  @ApiQuery({ name: 'cursor', required: false, type: String, description: 'Opaque pagination cursor from a previous page.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size, 1-100 (default 20).' })
  @ApiResponse({ status: 200, type: ProductListResponseDto })
  @ApiResponse({ status: 400, type: ErrorResponseDto, description: 'Invalid query parameters.' })
  async list(@Query() query: unknown): Promise<ListProductsResult> {
    const parsed = listProductsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((issue) => issue.message).join('; '));
    }
    return this.productsService.list(parsed.data);
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Fetch one product by slug, with its rating summary' })
  @ApiParam({ name: 'slug', type: String })
  @ApiResponse({ status: 200, type: ProductDetailResponseDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'No product has this slug.' })
  async detail(@Param('slug') slug: string): Promise<ProductDetailDto> {
    return this.productsService.getBySlug(slug);
  }
}

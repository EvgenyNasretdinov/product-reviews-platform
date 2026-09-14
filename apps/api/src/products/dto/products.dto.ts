import { productDetailDtoSchema, productDtoSchema } from '@reviews/contracts';
import { createZodDto } from 'nestjs-zod';
import { productListSchema } from '../products.service.js';

// See auth/dto/auth.dto.ts for why these classes exist and why the
// controllers never construct them.
export class ProductResponseDto extends createZodDto(productDtoSchema) {}
export class ProductDetailResponseDto extends createZodDto(productDetailDtoSchema) {}

// `productListSchema` (`paginatedSchema(productDetailDtoSchema)`) is
// imported from the service rather than redefined here, the same reason
// that export exists in the first place — see products.service.ts's doc
// comment on it.
export class ProductListResponseDto extends createZodDto(productListSchema) {}

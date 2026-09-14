import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { ConfigModule } from './config/config.module.js';
import { PrismaModule } from './common/prisma/prisma.module.js';
import { RedisModule } from './common/redis/redis.module.js';
import { HealthModule } from './health/health.module.js';
import { ProductsModule } from './products/products.module.js';

@Module({
  imports: [ConfigModule, PrismaModule, RedisModule, AuthModule, HealthModule, ProductsModule],
})
export class AppModule {}

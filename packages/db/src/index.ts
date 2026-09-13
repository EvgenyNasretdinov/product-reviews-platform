import { PrismaClient } from '@prisma/client';

export * from '@prisma/client';
export { PrismaClient };

export function createPrismaClient(url?: string): PrismaClient {
  return new PrismaClient(url ? { datasources: { db: { url } } } : undefined);
}

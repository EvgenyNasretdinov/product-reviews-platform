import { randomUUID } from 'node:crypto';
import type { Product, ProductRatingSummary, Review, ReviewStatus, Role, User } from '@reviews/db';
import { hashPassword } from '../src/auth/password.js';
import type { PrismaService } from '../src/common/prisma/prisma.service.js';

/**
 * Shared fixtures for every integration suite in this plan. Kept in one
 * place so a fixture used by, say, the moderation suite and the votes suite
 * can never quietly drift apart.
 *
 * Every fixture is independent and safe to call repeatedly within a single
 * test: slugs and emails default to a fresh `randomUUID()` unless the
 * caller pins one, since `setupTestApp()` truncates every table *between*
 * tests but not within one.
 */

// argon2id hashing is deliberately slow (see src/auth/password.ts). Most
// callers of createUser don't care what the password actually is, only
// that a valid hash exists on the row, so the hash for the fixture default
// is computed once per worker process rather than once per call.
let defaultPasswordHashPromise: Promise<string> | undefined;
function getDefaultPasswordHash(): Promise<string> {
  defaultPasswordHashPromise ??= hashPassword('password123');
  return defaultPasswordHashPromise;
}

export interface CreateUserOverrides {
  email?: string;
  displayName?: string;
  role?: Role;
  passwordHash?: string;
}

export async function createUser(prisma: PrismaService, overrides: CreateUserOverrides = {}): Promise<User> {
  const passwordHash = overrides.passwordHash ?? (await getDefaultPasswordHash());
  return prisma.user.create({
    data: {
      email: overrides.email ?? `user-${randomUUID()}@example.com`,
      displayName: overrides.displayName ?? 'Test User',
      passwordHash,
      role: overrides.role ?? 'CUSTOMER',
    },
  });
}

export interface CreateProductOverrides {
  slug?: string;
  name?: string;
  description?: string;
  priceCents?: number;
  currency?: string;
  imageUrl?: string;
  createdAt?: Date;
}

export async function createProduct(prisma: PrismaService, overrides: CreateProductOverrides = {}): Promise<Product> {
  const slug = overrides.slug ?? `product-${randomUUID()}`;
  return prisma.product.create({
    data: {
      slug,
      name: overrides.name ?? 'Test Product',
      description: overrides.description ?? 'A product used for testing.',
      priceCents: overrides.priceCents ?? 1999,
      currency: overrides.currency ?? 'USD',
      imageUrl: overrides.imageUrl ?? `https://example.com/images/${slug}.jpg`,
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    },
  });
}

export interface CreateReviewOverrides {
  productId: string;
  authorId: string;
  rating?: number;
  title?: string;
  body?: string;
  status?: ReviewStatus;
  verifiedPurchase?: boolean;
  helpfulCount?: number;
  notHelpfulCount?: number;
  moderationReason?: string | null;
  createdAt?: Date;
  publishedAt?: Date | null;
}

export async function createReview(prisma: PrismaService, overrides: CreateReviewOverrides): Promise<Review> {
  const { productId, authorId, ...rest } = overrides;
  return prisma.review.create({
    data: {
      productId,
      authorId,
      rating: rest.rating ?? 5,
      title: rest.title ?? 'Great product',
      body: rest.body ?? 'This product exceeded my expectations.',
      status: rest.status ?? 'APPROVED',
      verifiedPurchase: rest.verifiedPurchase ?? false,
      helpfulCount: rest.helpfulCount ?? 0,
      notHelpfulCount: rest.notHelpfulCount ?? 0,
      ...(rest.moderationReason !== undefined ? { moderationReason: rest.moderationReason } : {}),
      ...(rest.createdAt ? { createdAt: rest.createdAt } : {}),
      ...(rest.publishedAt !== undefined ? { publishedAt: rest.publishedAt } : {}),
    },
  });
}

/**
 * Creates the materialised `product_rating_summary` row for `productId`,
 * computed from `ratings` rather than accepted as separate pre-aggregated
 * fields. Nothing in this plan maintains that projection yet (the worker
 * belongs to a later plan), so a test wanting a specific summary has to
 * build one by hand; computing it from the same ratings array the test
 * also fed into `createReview` is what keeps the fixture from ever
 * disagreeing with the reviews a test created alongside it.
 */
export async function createSummary(
  prisma: PrismaService,
  productId: string,
  ratings: number[],
): Promise<ProductRatingSummary> {
  const counts = [0, 0, 0, 0, 0];
  let ratingSum = 0;
  for (const rating of ratings) {
    counts[rating - 1] = (counts[rating - 1] ?? 0) + 1;
    ratingSum += rating;
  }
  const reviewCount = ratings.length;
  const averageRating = reviewCount > 0 ? ratingSum / reviewCount : 0;

  return prisma.productRatingSummary.create({
    data: {
      productId,
      reviewCount,
      ratingSum,
      averageRating,
      count1: counts[0] ?? 0,
      count2: counts[1] ?? 0,
      count3: counts[2] ?? 0,
      count4: counts[3] ?? 0,
      count5: counts[4] ?? 0,
    },
  });
}

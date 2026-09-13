-- This migration is hand-edited after generation. The edits below are
-- deliberate and MUST survive if this migration is ever regenerated from the
-- schema (e.g. via `prisma migrate diff` or a fresh `migrate dev`):
--
-- 1. `outbox.id` is created as `BIGINT GENERATED ALWAYS AS IDENTITY` instead
--    of the `BIGSERIAL` Prisma generates for `BigInt @id @default(autoincrement())`.
--    This is the SQL-standard identity column: the sequence is owned by the
--    column (not a separately droppable object), and `GENERATED ALWAYS`
--    rejects explicit inserts of `id`, which is the correct behaviour for an
--    append-only outbox journal. Prisma introspects an identity column back
--    as `autoincrement()`, so `prisma migrate dev` reports no drift against
--    this schema -- verified empirically, see
--    docs/adr/0004-identity-columns-over-bigserial.md.
--
-- 2. The `reviews_rating_range` CHECK constraint and the partial
--    `outbox_unpublished_idx` index (`WHERE published_at IS NULL`) cannot be
--    expressed in the Prisma schema language and are added by hand at the
--    end of this file. `schema.prisma` deliberately declares no `@@index`
--    for `outbox.id`: Prisma cannot represent a partial index, and an
--    ordinary `@@index` declaration for the same name makes `migrate dev`
--    believe the (unrepresentable) partial index is missing and try to
--    recreate it as a plain index, colliding with the real one. See the ADR
--    above for the empirical trace.
--
-- CreateEnum
CREATE TYPE "Role" AS ENUM ('CUSTOMER', 'MODERATOR');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'FLAGGED');

-- CreateEnum
CREATE TYPE "VoteValue" AS ENUM ('HELPFUL', 'NOT_HELPFUL');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'CUSTOMER',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "image_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchases" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "purchased_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "rating" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
    "verified_purchase" BOOLEAN NOT NULL DEFAULT false,
    "moderation_reason" TEXT,
    "helpful_count" INTEGER NOT NULL DEFAULT 0,
    "not_helpful_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_votes" (
    "review_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "value" "VoteValue" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_votes_pkey" PRIMARY KEY ("review_id","user_id")
);

-- CreateTable
CREATE TABLE "product_rating_summary" (
    "product_id" UUID NOT NULL,
    "review_count" INTEGER NOT NULL DEFAULT 0,
    "rating_sum" INTEGER NOT NULL DEFAULT 0,
    "average_rating" DECIMAL(3,2) NOT NULL DEFAULT 0,
    "count_1" INTEGER NOT NULL DEFAULT 0,
    "count_2" INTEGER NOT NULL DEFAULT 0,
    "count_3" INTEGER NOT NULL DEFAULT 0,
    "count_4" INTEGER NOT NULL DEFAULT 0,
    "count_5" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "product_rating_summary_pkey" PRIMARY KEY ("product_id")
);

-- CreateTable
CREATE TABLE "outbox" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "products_slug_key" ON "products"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "purchases_user_id_product_id_key" ON "purchases"("user_id", "product_id");

-- CreateIndex
CREATE INDEX "reviews_product_id_status_created_at_idx" ON "reviews"("product_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "reviews_product_id_status_helpful_count_idx" ON "reviews"("product_id", "status", "helpful_count" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "reviews_product_id_author_id_key" ON "reviews"("product_id", "author_id");

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_votes" ADD CONSTRAINT "review_votes_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_votes" ADD CONSTRAINT "review_votes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_rating_summary" ADD CONSTRAINT "product_rating_summary_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written: not expressible in the Prisma schema language (see the note
-- at the top of this file).
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_rating_range" CHECK ("rating" BETWEEN 1 AND 5);

DROP INDEX IF EXISTS "outbox_unpublished_idx";
CREATE INDEX "outbox_unpublished_idx" ON "outbox" ("id") WHERE "published_at" IS NULL;

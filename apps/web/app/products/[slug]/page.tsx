import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { productDetailDtoSchema, type ProductDetailDto } from '@reviews/contracts';
import { RatingStars } from '@/components/rating-stars';
import { ReviewList } from '@/components/review-list';
import { SignOutButton } from '@/components/sign-out-button';
import { WriteReviewSection } from '@/components/write-review-section';
import { apiFetch } from '@/lib/api-client';
import { ApiError } from '@/lib/errors';
import { getServerSession } from '@/lib/session';

interface ProductPageProps {
  params: Promise<{ slug: string }>;
}

function formatPrice(priceCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(priceCents / 100);
  } catch {
    return `${(priceCents / 100).toFixed(2)} ${currency}`;
  }
}

/**
 * Loads the product by slug, translating a 404 from the API into Next's
 * `notFound()` rather than letting an `ApiError` escape into the default
 * error boundary — a shopper following a stale or mistyped link should
 * see "product not found", not a generic 500 page. Any other failure
 * (network, schema mismatch) is allowed to propagate: those are genuine
 * outages, not a routing decision this page should paper over.
 */
async function loadProduct(slug: string): Promise<ProductDetailDto> {
  try {
    return await apiFetch(`/products/${slug}`, { schema: productDetailDtoSchema });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      notFound();
    }
    throw error;
  }
}

function ImagePlaceholder(): ReactNode {
  return (
    <div className="flex h-full w-full items-center justify-center bg-muted text-muted-foreground" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-16 w-16 opacity-40">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <circle cx="8.5" cy="9.5" r="1.5" />
        <path d="M21 16l-5.5-5.5a2 2 0 0 0-2.8 0L3 20" />
      </svg>
    </div>
  );
}

/**
 * The product header (image, name, price) is a Server Component, so the
 * page arrives as HTML with the product already in it rather than as a
 * loading state that fills in after a client fetch. `ReviewList` below it
 * is the Client Component boundary: sorting and filtering re-render only
 * that subtree, not this header, and the header never re-mounts or loses
 * scroll position while a shopper works the review list.
 */
export default async function ProductPage({ params }: ProductPageProps): Promise<ReactNode> {
  const { slug } = await params;
  const [product, user] = await Promise.all([loadProduct(slug), getServerSession()]);

  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-4">
          <Link href="/" className="text-lg font-semibold">
            Product Reviews
          </Link>
          {user ? (
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">Signed in as {user.displayName}</span>
              <SignOutButton />
            </div>
          ) : (
            <Link href="/login" className="text-sm font-medium underline-offset-4 hover:underline">
              Sign in
            </Link>
          )}
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-10 px-4 py-8">
        <Link href="/" className="text-sm font-medium text-muted-foreground underline-offset-4 hover:underline">
          &larr; Back to catalogue
        </Link>

        <div className="grid grid-cols-1 gap-8 sm:grid-cols-2">
          <div className="aspect-square w-full overflow-hidden rounded-lg border border-border">
            {product.imageUrl ? (
              // Plain <img>, matching ProductCard: this app has no
              // next/image remote-pattern config, and it isn't worth
              // adding for a seeded demo catalogue.
              <img src={product.imageUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <ImagePlaceholder />
            )}
          </div>

          <div className="flex flex-col gap-4">
            <h1 className="text-2xl font-semibold">{product.name}</h1>
            <RatingStars value={product.summary.averageRating} count={product.summary.reviewCount} />
            <p className="text-xl font-semibold">{formatPrice(product.priceCents, product.currency)}</p>
            <p className="text-sm text-foreground/90">{product.description}</p>
          </div>
        </div>

        <WriteReviewSection productId={product.id} isSignedIn={user !== null} />

        <ReviewList productId={product.id} summary={product.summary} />
      </main>
    </div>
  );
}

import Link from 'next/link';
import type { ReactNode } from 'react';
import type { ProductDetailDto } from '@reviews/contracts';
import { RatingStars } from '@/components/rating-stars';

interface ProductCardProps {
  product: ProductDetailDto;
}

function formatPrice(priceCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(priceCents / 100);
  } catch {
    // An unrecognised currency code shouldn't take the whole card down —
    // fall back to a plain number rather than letting Intl throw past us.
    return `${(priceCents / 100).toFixed(2)} ${currency}`;
  }
}

/**
 * A decorative stand-in for a missing product photo. `imageUrl` is
 * `z.string().url().nullable()` in the contract, deliberately not an
 * empty string (see products.ts's doc comment) — this is the branch that
 * decision exists for. An empty `src` produces a broken-image icon and,
 * in some browsers, a spurious request to the page's own URL, so a
 * missing image gets a real placeholder graphic instead of an `<img>` at
 * all.
 */
function ImagePlaceholder(): ReactNode {
  return (
    <div
      className="flex h-full w-full items-center justify-center bg-muted text-muted-foreground"
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        className="h-10 w-10 opacity-40"
      >
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <circle cx="8.5" cy="9.5" r="1.5" />
        <path d="M21 16l-5.5-5.5a2 2 0 0 0-2.8 0L3 20" />
      </svg>
    </div>
  );
}

export function ProductCard({ product }: ProductCardProps): ReactNode {
  const { summary } = product;

  return (
    <Link
      href={`/products/${product.slug}`}
      className="group flex h-full flex-col overflow-hidden rounded-lg border border-border bg-card transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <div className="aspect-square w-full overflow-hidden">
        {product.imageUrl ? (
          // Decorative in context: the product name is already announced by
          // the heading below, inside this same link — a repeated alt text
          // would double up every card's accessible name for no benefit.
          <img
            src={product.imageUrl}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition-transform group-hover:scale-105"
          />
        ) : (
          <ImagePlaceholder />
        )}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <h2 className="line-clamp-2 text-sm font-medium">{product.name}</h2>
        <RatingStars value={summary.averageRating} count={summary.reviewCount} size="sm" />
        <p className="mt-auto text-base font-semibold">{formatPrice(product.priceCents, product.currency)}</p>
      </div>
    </Link>
  );
}

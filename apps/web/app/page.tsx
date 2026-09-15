import Link from 'next/link';
import type { ReactNode } from 'react';
import { paginatedSchema, productDetailDtoSchema, type ProductDetailDto } from '@reviews/contracts';
import { EmptyState } from '@/components/empty-state';
import { ProductCard } from '@/components/product-card';
import { SearchField } from '@/components/search-field';
import { SignOutButton } from '@/components/sign-out-button';
import { ThemeToggle } from '@/components/theme-toggle';
import { apiFetch } from '@/lib/api-client';
import { ApiError } from '@/lib/errors';
import { getServerSession } from '@/lib/session';

const productListSchema = paginatedSchema(productDetailDtoSchema);
const PAGE_SIZE = 24;

interface HomePageProps {
  // Next 16 hands Server Components their searchParams as a Promise.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

interface Catalogue {
  items: ProductDetailDto[];
  nextCursor: string | null;
  error: string | null;
}

function firstValue(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return (raw ?? '').trim();
}

/**
 * Fetches one page of the catalogue and never throws: `apiFetch` turns a
 * non-2xx response, a network failure, or a body that fails
 * `productListSchema` into an `ApiError`, and the alternative to catching
 * it here is an unhandled rejection taking down a public storefront page
 * over what might be a transient API blip.
 */
async function loadCatalogue(query: string, cursor: string): Promise<Catalogue> {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (cursor) params.set('cursor', cursor);
  params.set('limit', String(PAGE_SIZE));

  try {
    const result = await apiFetch(`/products?${params.toString()}`, { schema: productListSchema });
    return { ...result, error: null };
  } catch (error) {
    const message = error instanceof ApiError ? error.message : 'Something went wrong loading the catalogue.';
    return { items: [], nextCursor: null, error: message };
  }
}

function nextPageHref(query: string, cursor: string): string {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  params.set('cursor', cursor);
  return `/?${params.toString()}`;
}

export default async function HomePage({ searchParams }: HomePageProps): Promise<ReactNode> {
  const resolvedSearchParams = await searchParams;
  const query = firstValue(resolvedSearchParams.q);
  const cursor = firstValue(resolvedSearchParams.cursor);

  const [user, catalogue] = await Promise.all([getServerSession(), loadCatalogue(query, cursor)]);

  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-4">
          <Link href="/" className="text-lg font-semibold">
            Product Reviews
          </Link>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            {user ? (
              <>
                {user.role === 'MODERATOR' ? (
                  <Link href="/moderation" className="text-sm font-medium underline-offset-4 hover:underline">
                    Moderation queue
                  </Link>
                ) : null}
                <span className="text-sm text-muted-foreground">Signed in as {user.displayName}</span>
                <SignOutButton />
              </>
            ) : (
              <Link href="/login" className="text-sm font-medium underline-offset-4 hover:underline">
                Sign in
              </Link>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="mb-6 text-2xl font-semibold">Products</h1>

        <div className="mb-8 max-w-md">
          <SearchField defaultValue={query} />
        </div>

        {catalogue.error ? (
          <EmptyState
            title="The catalogue is unavailable"
            description="We couldn't load products right now. Please try again shortly."
          />
        ) : catalogue.items.length === 0 && query ? (
          <EmptyState
            title={`No products match "${query}"`}
            description="Try a different search term, or browse the full catalogue."
            action={
              <Link href="/" className="text-sm font-medium underline-offset-4 hover:underline">
                Clear search
              </Link>
            }
          />
        ) : catalogue.items.length === 0 ? (
          <EmptyState title="No products yet" description="Check back soon — the catalogue is currently empty." />
        ) : (
          <>
            <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {catalogue.items.map((product) => (
                <li key={product.id}>
                  <ProductCard product={product} />
                </li>
              ))}
            </ul>
            {catalogue.nextCursor ? (
              <div className="mt-8 flex justify-center">
                <Link
                  href={nextPageHref(query, catalogue.nextCursor)}
                  className="text-sm font-medium underline-offset-4 hover:underline"
                >
                  Load more
                </Link>
              </div>
            ) : null}
          </>
        )}
      </main>
    </div>
  );
}

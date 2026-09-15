'use client';

import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';
import { paginatedSchema, reviewDtoSchema, type ReviewDto, type ReviewSort } from '@reviews/contracts';
import { apiFetch } from '@/lib/api-client';

const reviewListSchema = paginatedSchema(reviewDtoSchema);

interface ReviewPage {
  items: ReviewDto[];
  nextCursor: string | null;
}

interface UseReviewsOptions {
  sort: ReviewSort;
  /** `null` for no filter; otherwise a 1-5 star value. */
  rating: number | null;
}

async function fetchReviewPage(productId: string, sort: ReviewSort, rating: number | null, cursor: string | undefined): Promise<ReviewPage> {
  const params = new URLSearchParams();
  params.set('sort', sort);
  if (rating !== null) {
    params.set('rating', String(rating));
  }
  if (cursor) {
    params.set('cursor', cursor);
  }
  return apiFetch(`/products/${productId}/reviews?${params.toString()}`, { schema: reviewListSchema });
}

/**
 * Pages a product's review list with TanStack Query's `useInfiniteQuery`,
 * keyed on `['reviews', productId, sort, rating]`. The key including
 * `sort` and `rating` is what keeps a cursor from one sort or filter from
 * ever being replayed under another: the API scopes each cursor to the
 * sort that produced it and answers 400 if it's reused under a different
 * one (see reviews.controller.ts), and a query key change makes TanStack
 * Query start a brand-new cache entry — with its own, empty page list and
 * `initialPageParam` — rather than continue paging the old one. Selecting
 * a different sort or rating can therefore never carry a stale cursor
 * forward; there is no code path that would let it.
 */
export function useReviews(productId: string, { sort, rating }: UseReviewsOptions) {
  return useInfiniteQuery<ReviewPage, Error, InfiniteData<ReviewPage>, readonly unknown[], string | undefined>({
    queryKey: ['reviews', productId, sort, rating],
    queryFn: ({ pageParam }) => fetchReviewPage(productId, sort, rating, pageParam),
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

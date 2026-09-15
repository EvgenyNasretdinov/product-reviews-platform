import type { ReactNode } from 'react';
import type { ReviewSort } from '@reviews/contracts';

const SORT_OPTIONS: Array<{ value: ReviewSort; label: string }> = [
  { value: 'helpful', label: 'Most helpful' },
  { value: 'newest', label: 'Newest' },
  { value: 'rating_desc', label: 'Highest rated' },
  { value: 'rating_asc', label: 'Lowest rated' },
];

interface ReviewSortSelectProps {
  value: ReviewSort;
  onChange: (sort: ReviewSort) => void;
}

export function ReviewSortSelect({ value, onChange }: ReviewSortSelectProps): ReactNode {
  return (
    <div className="flex items-center gap-2">
      <label htmlFor="review-sort" className="text-sm text-muted-foreground">
        Sort by
      </label>
      <select
        id="review-sort"
        value={value}
        onChange={(event) => onChange(event.target.value as ReviewSort)}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        {SORT_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

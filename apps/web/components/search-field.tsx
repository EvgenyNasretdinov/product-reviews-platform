import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface SearchFieldProps {
  defaultValue: string;
}

/**
 * A plain `<form>` GET submission, not a controlled input with an
 * `onChange` handler — the browser's own default form navigation is what
 * makes a search result a URL (`/?q=lamp`), which is what makes it
 * shareable, back-button-correct, and functional before any JavaScript
 * has loaded. No `'use client'` here; there is nothing in this component
 * that needs it.
 */
export function SearchField({ defaultValue }: SearchFieldProps): ReactNode {
  return (
    <form action="/" className="flex gap-2" role="search">
      <label htmlFor="catalogue-search" className="sr-only">
        Search products
      </label>
      <Input
        id="catalogue-search"
        type="search"
        name="q"
        placeholder="Search products…"
        defaultValue={defaultValue}
      />
      <Button type="submit">Search</Button>
    </form>
  );
}

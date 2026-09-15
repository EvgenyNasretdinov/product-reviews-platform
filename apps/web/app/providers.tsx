'use client';

import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';

/**
 * Single mounting point for every client-side context provider the app
 * needs, so app/layout.tsx itself stays a server component.
 *
 * The `QueryClient` is created inside `useState`'s lazy initializer, not
 * at module scope: a module-scoped client would be one instance shared by
 * every request the Node server handles, leaking one user's cached
 * reviews into another's response during SSR. `useState` gives each
 * component tree (each browser tab, each SSR pass) its own client while
 * still creating it exactly once per mount rather than on every render.
 */
export function Providers({ children }: { children: ReactNode }): ReactNode {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </ThemeProvider>
  );
}

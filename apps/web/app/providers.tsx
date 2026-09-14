'use client';

import type { ReactNode } from 'react';
import { ThemeProvider } from 'next-themes';

/**
 * Single mounting point for every client-side context provider the app
 * needs, so app/layout.tsx itself stays a server component. Only theming
 * lives here for now; a data-fetching client and any other cross-cutting
 * client context land here in later tasks rather than each growing its
 * own ad hoc provider in the tree.
 */
export function Providers({ children }: { children: ReactNode }): ReactNode {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      {children}
    </ThemeProvider>
  );
}

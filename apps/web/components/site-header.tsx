import Link from 'next/link';
import type { ReactNode } from 'react';
import { SignOutButton } from '@/components/sign-out-button';
import { ThemeToggle } from '@/components/theme-toggle';
import type { SessionUser } from '@/lib/session';

/**
 * The one header every page renders. It stays a server component — only
 * the theme toggle and the sign-out button need the browser, and each
 * opts into that itself — so a page using this still renders its session
 * state on the server rather than flashing a signed-out header first.
 *
 * `user` is the session or `null`; the signed-out branch is not dead code
 * on pages that require a session, since it is what the catalogue and
 * product pages show to an anonymous visitor.
 */
export function SiteHeader({ user }: { user: SessionUser | null }): ReactNode {
  return (
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
  );
}

import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { ModerationSection } from '@/components/moderation-section';
import { SignOutButton } from '@/components/sign-out-button';
import { ThemeToggle } from '@/components/theme-toggle';
import { getServerSession } from '@/lib/session';

/**
 * A submitted review is `PENDING` until an automatic classifier decides
 * it — approving, rejecting, or, when it isn't confident, routing it here
 * as `FLAGGED` for a human. This page is that human's screen: everything
 * currently `FLAGGED` or still `PENDING`, with the controls to approve
 * or reject each one.
 *
 * The redirect below happens here, server-side, before anything renders:
 * `ModerationController` already enforces `MODERATOR`-only on both
 * routes this page's hooks call (`RolesGuard`, 403 for anyone else — see
 * moderation.controller.ts), so a non-moderator could never actually
 * approve or reject anything even without this check. But a page that
 * renders the queue, the star ratings, the "Approve"/"Reject" buttons —
 * and only then has every one of those buttons fail with a 403 the
 * moment they're used — is a broken screen, not a secure one. Checking
 * the role here, before the first byte of the queue itself renders, is
 * what keeps a `CUSTOMER` who navigates to `/moderation` from seeing that
 * broken screen at all; the API's own guard remains the actual
 * authorization boundary, not this redirect.
 */
export default async function ModerationPage(): Promise<ReactNode> {
  const user = await getServerSession();
  if (!user || user.role !== 'MODERATOR') {
    redirect('/');
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-4">
          <Link href="/" className="text-lg font-semibold">
            Product Reviews
          </Link>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <span className="text-sm text-muted-foreground">Signed in as {user.displayName}</span>
            <SignOutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-4xl flex-col gap-10 px-4 py-8">
        <div>
          <h1 className="text-2xl font-semibold">Moderation queue</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Reviews the automatic classifier flagged, or hasn&rsquo;t classified yet, waiting on your decision.
          </p>
        </div>

        <ModerationSection
          status="FLAGGED"
          title="Flagged for review"
          emptyTitle="No flagged reviews"
          emptyDescription="The classifier hasn't flagged anything for you right now."
        />

        <ModerationSection
          status="PENDING"
          title="Pending review"
          emptyTitle="No pending reviews"
          emptyDescription="Every submitted review has already been classified."
        />
      </main>
    </div>
  );
}

'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import type { VoteValue } from '@reviews/contracts';
import { cn } from '@/lib/utils';

export interface VoteButtonsProps {
  reviewId: string;
  helpfulCount: number;
  notHelpfulCount: number;
  /**
   * Casts, moves, or clears the caller's helpfulness vote. `value` is
   * where the vote is moving to (`null` clears it); `previousVote` is
   * what this component currently believes the caller's own vote was,
   * passed along purely so a caller wiring in `useVote` can compute the
   * right delta for its cached counts — the server never reports a
   * per-user vote back on any read (see `VoteCountsResponseDto` in the
   * API's `votes.dto.ts`), so this component's own `activeVote` state
   * below is the only place that knows it. Rejecting rolls this
   * component's own optimistic counts back and surfaces a message.
   */
  onVote: (value: VoteValue | null, previousVote: VoteValue | null) => Promise<unknown>;
  /** True when the signed-in caller may vote: signed in and not this review's own author. */
  canVote: boolean;
  /**
   * Ignored when `canVote` is true. Otherwise distinguishes *why* voting
   * isn't available: `false` renders a "sign in to vote" prompt, `true`
   * (the default) renders the counts alone — the author case, matching
   * the server's own rule (`VotesController#vote`'s 403) rather than
   * something this component infers from a failed request.
   */
  isSignedIn?: boolean;
}

interface LocalVoteState {
  helpfulCount: number;
  notHelpfulCount: number;
  /**
   * This component's own belief about the caller's vote — see the doc
   * comment on `onVote` above. Always starts `null` on mount, including on
   * every reload: nothing in `ReviewDto`/`VoteCountsResponseDto` reports a
   * per-user vote on any read (the review list is fetched without knowing
   * who's asking), so there is no truth to initialise this from. That's a
   * known, deliberate gap — see the README's "what I would do next" —
   * closing it properly would mean adding the caller's own vote to the
   * (currently `@Public()`, no-auth-required) review list response, which
   * needs optional authentication on that route, a contract change, and
   * updated OpenAPI docs/tests. Showing neither button pressed after a
   * reload is the honest state given that gap: guessing would be worse.
   */
  activeVote: VoteValue | null;
}

/** Applies the count delta for moving from `state.activeVote` to `nextVote`, one vote at a time — never both counters at once for a single click, which is what keeps a moved vote from ever reading as two. */
function moveVote(state: LocalVoteState, nextVote: VoteValue | null): LocalVoteState {
  let { helpfulCount, notHelpfulCount } = state;
  if (state.activeVote === 'HELPFUL') helpfulCount -= 1;
  if (state.activeVote === 'NOT_HELPFUL') notHelpfulCount -= 1;
  if (nextVote === 'HELPFUL') helpfulCount += 1;
  if (nextVote === 'NOT_HELPFUL') notHelpfulCount += 1;
  return { helpfulCount, notHelpfulCount, activeVote: nextVote };
}

function personCount(count: number): string {
  return count === 1 ? '1 person' : `${count} people`;
}

const toggleButtonClasses = (active: boolean): string =>
  cn(
    'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
    active ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-background hover:bg-secondary',
  );

/**
 * The interactive counterpart to the read-only counts `ReviewItem` used to
 * render in their place — see its doc comment. Owns its own optimistic
 * copy of the counts and of which vote it believes is currently active,
 * entirely as local state: it updates the instant a button is clicked and
 * rolls itself back if the `onVote` promise it was given rejects, with no
 * dependency on TanStack Query or any other cache. That independence is
 * what lets this component's own tests render it with a bare `vi.fn()`
 * for `onVote` and no `QueryClientProvider` at all — the cache-level
 * optimism a real caller layers on top lives in `useVote` instead.
 */
export function VoteButtons({
  reviewId,
  helpfulCount,
  notHelpfulCount,
  onVote,
  canVote,
  isSignedIn = true,
}: VoteButtonsProps): ReactNode {
  const [state, setState] = useState<LocalVoteState>({ helpfulCount, notHelpfulCount, activeVote: null });
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = `vote-error-${reviewId}`;

  // `useState`'s initializer above runs exactly once, at mount — but
  // ReviewList keys ReviewItem by review.id (see review-list.tsx), so a
  // refetch (in particular useVote's own onSettled invalidation, once it
  // lands) re-renders this *same* instance with new `helpfulCount`/
  // `notHelpfulCount` props rather than remounting it. Without this
  // effect those new props would be read once and then ignored forever:
  // the displayed counts would stay frozen at whichever optimistic guess
  // this component last made, even after the mutation that guess was
  // covering for has already settled and the true count is sitting right
  // there in props. This effect is what actually lets that settle-then-
  // refetch round trip reach the screen.
  //
  // The dependency array deliberately does *not* include `isPending`: it
  // is read only as a guard inside the effect body, never as a trigger.
  // If it were also a dependency, every click would re-run this effect
  // twice for nothing but the pending flag's own true→false flip — once
  // when the click starts (skipped, correctly, by the guard) and once the
  // instant `onVote` settles, at which point the effect would fire again
  // even though `helpfulCount`/`notHelpfulCount` themselves never changed,
  // reapplying those still-stale closed-over prop values straight over
  // the optimistic count `handleClick` just committed — undoing a
  // successful vote's own display the moment it finishes, before any
  // refetch had a chance to bring back the real number. Keying this
  // purely on the *props actually changing* is what keeps it a pure
  // "did new truth arrive" listener instead of a second, competing writer
  // to the same state `handleClick` owns. Leaves `activeVote` untouched
  // either way: this component still knows which button *it* just
  // pressed, even once the counts underneath catch up to a value someone
  // else's vote may also have touched.
  useEffect(() => {
    if (isPending) {
      return;
    }
    setState((current) => ({ ...current, helpfulCount, notHelpfulCount }));
  }, [helpfulCount, notHelpfulCount]);

  async function handleClick(target: VoteValue): Promise<void> {
    const previous = state;
    const nextVote = previous.activeVote === target ? null : target;
    setState(moveVote(previous, nextVote));
    setError(null);
    setIsPending(true);
    try {
      await onVote(nextVote, previous.activeVote);
    } catch {
      // The one case that matters: leave the caller believing a vote
      // landed when it didn't is worse than no optimism at all, so this
      // restores the exact pre-click snapshot rather than re-deriving it.
      setState(previous);
      setError("Couldn't record your vote. Please try again.");
    } finally {
      setIsPending(false);
    }
  }

  const total = state.helpfulCount + state.notHelpfulCount;

  if (!canVote) {
    return (
      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        {total > 0 ? (
          <p>
            {state.helpfulCount} of {total} found this helpful
          </p>
        ) : null}
        {!isSignedIn ? (
          <p>
            <Link href="/login" className="font-medium underline-offset-4 hover:underline">
              Sign in
            </Link>{' '}
            to say whether this review was helpful.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-pressed={state.activeVote === 'HELPFUL'}
          aria-label={`Helpful — ${personCount(state.helpfulCount)} found this helpful`}
          aria-describedby={error ? errorId : undefined}
          disabled={isPending}
          onClick={() => void handleClick('HELPFUL')}
          className={toggleButtonClasses(state.activeVote === 'HELPFUL')}
        >
          <span aria-hidden="true">Helpful</span>
          <span aria-hidden="true">{state.helpfulCount}</span>
        </button>

        <button
          type="button"
          aria-pressed={state.activeVote === 'NOT_HELPFUL'}
          aria-label={`Not useful — ${personCount(state.notHelpfulCount)} found this not useful`}
          aria-describedby={error ? errorId : undefined}
          disabled={isPending}
          onClick={() => void handleClick('NOT_HELPFUL')}
          className={toggleButtonClasses(state.activeVote === 'NOT_HELPFUL')}
        >
          <span aria-hidden="true">Not useful</span>
          <span aria-hidden="true">{state.notHelpfulCount}</span>
        </button>
      </div>

      {error ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

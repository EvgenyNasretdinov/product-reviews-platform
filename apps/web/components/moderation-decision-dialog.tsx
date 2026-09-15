'use client';

import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';

export interface ModerationDecisionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The review's own title, shown so a moderator can confirm this is the one they meant to reject. */
  reviewTitle: string;
  /**
   * Submits the rejection with the entered (already-trimmed) reason.
   * Resolving closes the dialog; rejecting keeps it open and shows the
   * message inline, the same "explain in place, don't lose what was
   * typed" pattern `ReviewForm` uses for a failed submit.
   */
  onConfirm: (reason: string) => Promise<void>;
}

/**
 * The reject flow's confirmation step — a real `Dialog` (Radix, via
 * components/ui/dialog.tsx), not `window.confirm`. `window.confirm` has
 * no way to collect the reason a rejection requires, and it has no focus
 * trap of its own to inherit; Radix's does: focus moves into this dialog
 * on open, Tab/Shift+Tab cycle only within it, Escape and an outside
 * click both close it (unless a submission is in flight — see the
 * `onOpenChange` guard below), and focus returns to the "Reject" button
 * that opened it once it closes.
 *
 * The confirm button stays disabled until a reason is entered: the
 * reason is what the review's own author sees in place of their review
 * (see `StatusBadge`), so a rejection with no reason would be
 * indistinguishable, from the author's side, from the review having
 * simply vanished.
 */
export function ModerationDecisionDialog({
  open,
  onOpenChange,
  reviewTitle,
  onConfirm,
}: ModerationDecisionDialogProps): ReactNode {
  const [reason, setReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonId = useId();
  const errorId = useId();

  // Every open is a fresh attempt: without this, closing after a failed
  // submission (or cancelling) and reopening — on this review or a
  // different one — would carry the previous attempt's typed reason and
  // error message along with it.
  useEffect(() => {
    if (open) {
      setReason('');
      setError(null);
      setIsSubmitting(false);
    }
  }, [open]);

  const trimmedReason = reason.trim();
  const canConfirm = trimmedReason.length > 0 && !isSubmitting;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canConfirm) {
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      await onConfirm(trimmedReason);
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn't reject this review. Please try again.");
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (isSubmitting ? undefined : onOpenChange(next))}>
      <DialogContent>
        <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Reject this review?</DialogTitle>
            <DialogDescription>
              &ldquo;{reviewTitle}&rdquo; will not be published. The reason you enter is what the author sees in
              its place.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <Label htmlFor={reasonId}>Reason</Label>
            <textarea
              id={reasonId}
              rows={4}
              autoFocus
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              aria-describedby={error ? errorId : undefined}
              placeholder="Why is this review being rejected?"
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>

          {error ? (
            <p id={errorId} role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={!canConfirm}>
              {isSubmitting ? 'Rejecting…' : 'Reject review'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

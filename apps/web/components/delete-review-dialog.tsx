'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export interface DeleteReviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The review's own title, so the author can confirm this is the one they meant. */
  reviewTitle: string;
  /**
   * Performs the deletion. Resolving closes the dialog; rejecting keeps
   * it open and shows the message inline, so a failed delete does not
   * look like a successful one.
   */
  onConfirm: () => Promise<void>;
}

/**
 * The confirmation step in front of deleting a review. A real dialog
 * rather than `window.confirm` for the same reasons the reject flow uses
 * one (see `moderation-decision-dialog.tsx`): Radix gives it a genuine
 * focus trap and an Escape/outside-click close, and — unlike
 * `window.confirm` — it can report a failed delete in place instead of
 * vanishing and leaving the author guessing.
 *
 * Confirmation is warranted here specifically because the API's delete is
 * a hard delete: the row is gone, its votes cascade with it, and nothing
 * restores them. That is also why the button is `destructive` and says
 * "Delete review" rather than "OK" — the label should name the
 * consequence, so a misclick is caught by reading rather than by memory.
 */
export function DeleteReviewDialog({
  open,
  onOpenChange,
  reviewTitle,
  onConfirm,
}: DeleteReviewDialogProps): ReactNode {
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Every open is a fresh attempt: without this, reopening after a failed
  // delete would still be showing the previous attempt's error.
  useEffect(() => {
    if (open) {
      setError(null);
      setIsDeleting(false);
    }
  }, [open]);

  async function confirm(): Promise<void> {
    setError(null);
    setIsDeleting(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Deleting your review failed. Please try again.');
      setIsDeleting(false);
    }
  }

  return (
    <Dialog
      open={open}
      // Refuses to close while the delete is in flight. Closing mid-request
      // would leave the outcome unreported: the request still lands, but
      // there is no longer anywhere to show that it failed.
      onOpenChange={(next) => {
        if (!isDeleting) onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete this review?</DialogTitle>
          <DialogDescription>
            “{reviewTitle}” will be removed permanently, along with any helpful votes it received. This cannot be
            undone.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={isDeleting}>
            Keep it
          </Button>
          <Button type="button" variant="destructive" onClick={() => void confirm()} disabled={isDeleting}>
            {isDeleting ? 'Deleting…' : 'Delete review'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

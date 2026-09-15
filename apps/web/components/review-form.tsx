'use client';

import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { createReviewInputSchema, type CreateReviewInput } from '@reviews/contracts';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/errors';

const RATING_VALUES = [1, 2, 3, 4, 5] as const;

/**
 * Sentinel for "no star picked yet". `CreateReviewInput.rating` is a
 * required 1-5 integer — the schema has no notion of an absent rating,
 * and it shouldn't: the API never wants a review without one. Rather than
 * widen the form's type to `number | undefined` and narrow it back before
 * every submit, the form's empty state is modelled as the one integer
 * `createReviewInputSchema`'s own `.min(1)` already rejects. That keeps
 * `useForm<CreateReviewInput>` honest (no field is ever a different type
 * from what the API actually accepts) while still making "nothing chosen
 * yet" a value that fails validation like any other incomplete field.
 */
const UNSET_RATING = 0;

/**
 * `createReviewInputSchema` itself, with `rating` widened to coerce a
 * string into a number before every other check runs. This exists solely
 * because of how react-hook-form reads radio inputs: for `type="radio"`
 * it always takes the raw DOM string value and — unlike text inputs —
 * completely ignores `register`'s `valueAsNumber`/`setValueAs` options
 * (see `getFieldValue` in react-hook-form's own source: the radio branch
 * calls `getRadioValue` directly, bypassing the code path that would
 * otherwise apply either). Coercing here, in the schema that's the single
 * source of truth for both live validity and the resolver, is what turns
 * that raw `"4"` into the `4` the API (and `onSubmit`'s caller) actually
 * expects — without it, a chosen rating would fail `z.number()` forever
 * and the button would never enable.
 */
const reviewFormSchema = createReviewInputSchema.extend({
  rating: z.coerce.number().int().min(1).max(5),
});

export interface ReviewFormProps {
  productId: string;
  /**
   * Submits the validated input; owning the actual network call (and its
   * success/error handling) is deliberately not this component's job —
   * see `useSubmitReview`, which is what a real caller wires in here. That
   * split is what lets this component's own tests render it with a plain
   * `vi.fn()` and no `QueryClientProvider` at all.
   */
  onSubmit: (input: CreateReviewInput) => Promise<unknown>;
  /**
   * Prefills the fields. Supplied when editing an existing review, so the
   * author starts from what they wrote rather than a blank form; omitted
   * when writing a new one.
   */
  defaultValues?: CreateReviewInput;
  /** Overrides the submit button's idle and in-flight labels. */
  submitLabel?: string;
  submittingLabel?: string;
  /**
   * Renders a Cancel button beside submit when provided. Editing needs a
   * way back to the review as it stands; first-time writing has nothing
   * to go back to, so the button is absent rather than inert.
   */
  onCancel?: () => void;
  /** Replaces the note under the button about reviews being checked. */
  hint?: string;
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  return 'Something went wrong submitting your review. Please try again.';
}

/**
 * `productId` isn't sent anywhere from inside this component — it's not
 * part of `createReviewInputSchema` (the product is already fixed by the
 * URL the caller POSTs to) and this form never constructs that URL
 * itself. It's accepted as a prop purely so a caller wiring in
 * `useSubmitReview(productId)` has one prop to pass instead of having to
 * thread the id past this component to get to its own `onSubmit`.
 */
export function ReviewForm({
  onSubmit,
  defaultValues,
  submitLabel = 'Submit review',
  submittingLabel = 'Submitting…',
  onCancel,
  hint = 'Reviews are checked before they appear publicly, usually within moments.',
}: ReviewFormProps): ReactNode {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<CreateReviewInput>({
    resolver: zodResolver(reviewFormSchema),
    mode: 'onChange',
    // `rating` is stringified for the same reason the schema above
    // coerces it back: react-hook-form checks a radio by comparing the
    // default against the input's raw DOM `value`, which is always a
    // string. Handing it the number 4 leaves every star unchecked, so
    // opening an existing review to edit it would silently drop the
    // rating — the field reads as "nothing chosen yet" and the save
    // button never enables. Covered by your-review-section.test.tsx's
    // "opens a prefilled form on Edit".
    //
    // The cast is the honest shape of that: this one field holds a string
    // until the resolver coerces it, while the type describes what the
    // API receives. Widening the type parameter instead does not
    // typecheck — zodResolver's `Resolver` is pinned to the schema's
    // output type, so `useForm` and the resolver would disagree.
    defaultValues: defaultValues
      ? ({
          rating: String(defaultValues.rating),
          title: defaultValues.title,
          body: defaultValues.body,
        } as unknown as CreateReviewInput)
      : { rating: UNSET_RATING, title: '', body: '' },
  });

  // Drives the disabled state directly off the same schema the resolver
  // uses, rather than off react-hook-form's own `formState.isValid`:
  // `isValid` only reflects reality once a field has actually been
  // validated, which — before any interaction at all — would report
  // "valid" for a completely empty form. Parsing `watch()`'s current
  // snapshot on every render has no such warm-up: it's correct from the
  // very first paint, which is what "disabled until valid" requires.
  const values = watch();
  const isFormValid = reviewFormSchema.safeParse(values).success;

  async function onValid(input: CreateReviewInput): Promise<void> {
    setSubmitError(null);
    try {
      await onSubmit(input);
      // No reset() on success either: the caller that wired a real
      // onSubmit in (see write-review-section.tsx) swaps this form out
      // for the "Your review" panel once the submission lands, so there's
      // no moment where a freshly-cleared form would be visible to clear.
    } catch (error) {
      setSubmitError(messageFor(error));
      // Deliberately no reset() here. Losing a paragraph someone just
      // wrote to a network blip is the one failure mode this form must
      // never produce — react-hook-form's fields are uncontrolled by
      // default, so simply not calling reset() is enough to keep them.
    }
  }

  return (
    <form
      onSubmit={(event) => {
        void handleSubmit(onValid)(event);
      }}
      className="flex flex-col gap-4"
      noValidate
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Rating</legend>
        {/* A native radio group, not a row of clickable spans: arrow keys
            move between the five options and each option's aria-label
            (rather than adjacent text) is what a screen reader announces
            as its accessible name. */}
        <div role="radiogroup" aria-label="Rating" className="flex gap-3">
          {RATING_VALUES.map((value) => (
            <label key={value} className="flex flex-col items-center gap-1 text-xs text-muted-foreground">
              <input
                type="radio"
                value={value}
                aria-label={`${value} star${value === 1 ? '' : 's'}`}
                className="h-4 w-4 accent-amber-500"
                {...register('rating')}
              />
              <span aria-hidden="true">{value}★</span>
            </label>
          ))}
        </div>
        {errors.rating ? <p className="text-sm text-destructive">Choose a star rating.</p> : null}
      </fieldset>

      <div className="flex flex-col gap-2">
        <Label htmlFor="review-title">Title</Label>
        <Input
          id="review-title"
          aria-invalid={Boolean(errors.title)}
          aria-describedby={errors.title ? 'review-title-error' : undefined}
          {...register('title')}
        />
        {errors.title ? (
          <p id="review-title-error" className="text-sm text-destructive">
            {errors.title.message}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="review-body">Review</Label>
        <textarea
          id="review-body"
          rows={5}
          className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-invalid={Boolean(errors.body)}
          aria-describedby={errors.body ? 'review-body-error' : undefined}
          {...register('body')}
        />
        {errors.body ? (
          <p id="review-body-error" className="text-sm text-destructive">
            {errors.body.message}
          </p>
        ) : null}
      </div>

      {submitError ? (
        <p role="alert" className="text-sm text-destructive">
          {submitError}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={!isFormValid || isSubmitting}>
          {isSubmitting ? submittingLabel : submitLabel}
        </Button>
        {onCancel ? (
          // Stays enabled while a submission is in flight: a request that
          // hangs is exactly when someone most wants out, and abandoning
          // the edit costs nothing that is not already on the server.
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>

      <p className="text-xs text-muted-foreground">{hint}</p>
    </form>
  );
}

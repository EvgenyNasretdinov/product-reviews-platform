import type { ReactNode } from 'react';

interface EmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
}

/**
 * A generic "nothing here" panel, reused for every empty state the
 * catalogue actually hits: no products exist yet, and a search matched
 * nothing. Kept deliberately plain — the point is that these states exist
 * and say something useful, not that they look elaborate.
 */
export function EmptyState({ title, description, action }: EmptyStateProps): ReactNode {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-20 text-center">
      <h2 className="text-lg font-medium">{title}</h2>
      {description ? <p className="max-w-sm text-sm text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

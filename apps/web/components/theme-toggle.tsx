'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useTheme } from 'next-themes';
import { Button } from '@/components/ui/button';

/**
 * Three states rather than two. A plain light/dark switch can express
 * "follow the system" only until the first click, after which the choice
 * is pinned forever and there is no way back — so someone whose OS
 * switches to dark in the evening keeps getting whatever they last
 * pressed. Cycling through system as its own state keeps that door open.
 */
const ORDER = ['system', 'light', 'dark'] as const;
type ThemeChoice = (typeof ORDER)[number];

const LABELS: Record<ThemeChoice, string> = {
  system: 'system',
  light: 'light',
  dark: 'dark',
};

function nextChoice(current: ThemeChoice): ThemeChoice {
  return ORDER[(ORDER.indexOf(current) + 1) % ORDER.length]!;
}

function ThemeIcon({ choice }: { choice: ThemeChoice }): ReactNode {
  const shared = {
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };

  if (choice === 'light') {
    return (
      <svg {...shared}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
      </svg>
    );
  }

  if (choice === 'dark') {
    return (
      <svg {...shared}>
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
      </svg>
    );
  }

  return (
    <svg {...shared}>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

export function ThemeToggle(): ReactNode {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // `theme` is undefined on the server and on the first client render,
  // because the stored preference only exists in the browser. Rendering
  // the real icon before that point is a guaranteed hydration mismatch,
  // so the button renders at its final size with nothing in it until the
  // preference is known — same footprint, no layout shift, nothing for
  // React to reconcile.
  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return <Button type="button" variant="outline" size="icon" aria-hidden tabIndex={-1} />;
  }

  const current = (ORDER as readonly string[]).includes(theme ?? '') ? (theme as ThemeChoice) : 'system';
  const next = nextChoice(current);
  const label = `Theme: ${LABELS[current]}. Switch to ${LABELS[next]}.`;

  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      onClick={() => setTheme(next)}
      aria-label={label}
      title={label}
    >
      <ThemeIcon choice={current} />
    </Button>
  );
}

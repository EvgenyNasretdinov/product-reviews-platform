// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeToggle } from './theme-toggle';

const setTheme = vi.fn();
let theme: string | undefined = 'system';

vi.mock('next-themes', () => ({
  useTheme: () => ({ theme, setTheme }),
}));

beforeEach(() => {
  setTheme.mockClear();
  theme = 'system';
});

describe('ThemeToggle', () => {
  it('cycles system -> light -> dark -> system, so "follow the system" stays reachable', async () => {
    const user = userEvent.setup();

    for (const [current, expected] of [
      ['system', 'light'],
      ['light', 'dark'],
      ['dark', 'system'],
    ] as const) {
      theme = current;
      const { unmount } = render(<ThemeToggle />);

      await user.click(screen.getByRole('button'));

      expect(setTheme).toHaveBeenLastCalledWith(expected);
      unmount();
    }
  });

  it('names both the current theme and what pressing it will do', () => {
    theme = 'dark';
    render(<ThemeToggle />);

    // A bare "Toggle theme" label leaves a screen-reader user unable to
    // tell which of three states they are currently in.
    expect(screen.getByRole('button', { name: 'Theme: dark. Switch to system.' })).toBeInTheDocument();
  });

  it('falls back to system when the stored preference is not one it knows', async () => {
    const user = userEvent.setup();
    theme = 'solarized';
    render(<ThemeToggle />);

    expect(screen.getByRole('button', { name: /Theme: system/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button'));
    expect(setTheme).toHaveBeenCalledWith('light');
  });

  it('renders no icon on the server, so hydration has nothing to reconcile', () => {
    // The markup the server sends is the thing that has to match the
    // browser's first render. `render()` cannot check this: Testing
    // Library flushes effects, so `mounted` is already true by the time
    // any assertion runs and the real icon is on screen. Rendering to a
    // string is what actually exercises the effect-free path.
    theme = undefined;
    const html = renderToString(<ThemeToggle />);

    expect(html).toContain('<button');
    expect(html).not.toContain('<svg');
    // Nothing for a screen reader to announce while it is still inert.
    expect(html).not.toContain('aria-label');
  });
});

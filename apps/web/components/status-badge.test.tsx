// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBadge } from './status-badge';

describe('StatusBadge', () => {
  it('renders "Awaiting moderation" with a neutral tone for a PENDING review', () => {
    render(<StatusBadge status="PENDING" moderationReason={null} />);

    const badge = screen.getByText('Awaiting moderation');
    expect(badge).toBeInTheDocument();
    // Neutral, not alarming: no destructive/error styling on the pending state.
    expect(badge.className).not.toMatch(/destructive/);
  });

  it('treats FLAGGED the same as PENDING from the author\'s point of view', () => {
    render(<StatusBadge status="FLAGGED" moderationReason={null} />);
    expect(screen.getByText('Awaiting moderation')).toBeInTheDocument();
  });

  it('renders the moderation reason for a REJECTED review', () => {
    render(<StatusBadge status="REJECTED" moderationReason="Contains contact information" />);

    expect(screen.getByText(/Contains contact information/)).toBeInTheDocument();
  });

  it('renders nothing for an APPROVED review, since a published review needs no badge', () => {
    const { container } = render(<StatusBadge status="APPROVED" moderationReason={null} />);

    expect(container).toBeEmptyDOMElement();
  });
});

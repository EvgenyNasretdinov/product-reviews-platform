import { EVENT_TYPES } from '@reviews/contracts';
import { describe, expect, it } from 'vitest';
import { dlqName, TOPOLOGY } from './topology.js';

describe('TOPOLOGY', () => {
  it('binds every event type that a consumer needs', () => {
    const bound = Object.values(TOPOLOGY.queues).flatMap((q) => q.bindings);
    expect(bound).toContain(EVENT_TYPES.REVIEW_SUBMITTED);
    expect(bound).toContain(EVENT_TYPES.REVIEW_APPROVED);
    expect(bound).toContain(EVENT_TYPES.REVIEW_UNPUBLISHED);
  });

  it('only binds routing keys that are real event types', () => {
    const known = new Set<string>(Object.values(EVENT_TYPES));
    for (const queue of Object.values(TOPOLOGY.queues)) {
      for (const binding of queue.bindings) expect(known).toContain(binding);
    }
  });

  it('derives a dead-letter queue name per queue', () => {
    expect(dlqName(TOPOLOGY.queues.moderation.name)).toBe('moderation.review-submitted.dlq');
  });
});

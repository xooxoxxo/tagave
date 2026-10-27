import { describe, expect, it } from 'vitest';
import { identifyTodoCount, reasonChipCount } from './identifyCounts';

const stats = {
  states: { matched: 0, needsReview: 0, pending: 3, unidentified: 4 },
  reasons: { weak_candidates: 2, no_candidates: 1, job_failed: 0 },
};

describe('identifyTodoCount', () => {
  it('counts the albums still waiting and the ones not matched (QA Q-18: "Identify albums 0" with 7 waiting)', () => {
    expect(identifyTodoCount(stats)).toBe(7);
    expect(identifyTodoCount({ ...stats, states: { pending: 0, unidentified: 0 } })).toBe(0);
  });

  it('is unknown while the stats load', () => {
    expect(identifyTodoCount(undefined)).toBeUndefined();
  });
});

describe('reasonChipCount', () => {
  it('"All" is every album the unfiltered list shows (QA Q-15: "All 0" beside 4 rows)', () => {
    expect(reasonChipCount(null, stats)).toBe(4);
  });

  it('a reason chip is its own count', () => {
    expect(reasonChipCount('weak_candidates', stats)).toBe(2);
    expect(reasonChipCount('provider_errors', stats)).toBe(0);
  });
});

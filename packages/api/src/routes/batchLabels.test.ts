import { describe, it, expect } from 'vitest';
import { batchFailedDuring, deciderLabel, pendingLabel } from '@tagave/shared';

describe('accept batch labels', () => {
  it('names a decider by its id and dated version', () => {
    expect(deciderLabel('jev', 'jev-2026-09-15')).toBe('Jev 2026-09');
    expect(deciderLabel('rules', null)).toBe('Your rules');
    expect(deciderLabel('jev', 'latest')).toBe('Jev');
    expect(deciderLabel('jev', null)).toBe('Jev');
  });
  it('tells a failed accept from a failed undo', () => {
    expect(batchFailedDuring('failed', 'Undo stopped: x')).toBe('undo');
    expect(batchFailedDuring('failed', 'Accept stopped: x')).toBe('accept');
    expect(batchFailedDuring('accepted', 'Undo stopped: x')).toBeNull();
  });
  it('pending albums wait while the accept runs, and were not reached once it stopped', () => {
    expect(pendingLabel('accepting')).toBe('Waiting');
    expect(pendingLabel('undone')).toBe('Not reached');
    expect(pendingLabel('undoing')).toBe('Not reached');
  });
});

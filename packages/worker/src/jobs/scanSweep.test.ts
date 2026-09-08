import { describe, it, expect } from 'vitest';
import { scanDecision } from './scanSweep.js';

const H = 3600_000;
const D = 24 * H;
const now = new Date('2026-09-08T12:00:00Z');
const at = (msAgo: number) => new Date(now.getTime() - msAgo);

describe('scanDecision', () => {
  it('never scanned → full', () => {
    expect(scanDecision({ now, pollIntervalS: 21600, lastCompletedAt: null, lastFullCompletedAt: null, running: false, fullEveryDays: 7 })).toBe('full');
  });

  it('inside the poll interval → nothing', () => {
    expect(scanDecision({ now, pollIntervalS: 21600, lastCompletedAt: at(1 * H), lastFullCompletedAt: at(1 * H), running: false, fullEveryDays: 7 })).toBeNull();
  });

  it('poll elapsed, full is recent → quick', () => {
    expect(scanDecision({ now, pollIntervalS: 21600, lastCompletedAt: at(7 * H), lastFullCompletedAt: at(2 * D), running: false, fullEveryDays: 7 })).toBe('quick');
  });

  it('poll elapsed, full older than a week → full', () => {
    expect(scanDecision({ now, pollIntervalS: 21600, lastCompletedAt: at(7 * H), lastFullCompletedAt: at(8 * D), running: false, fullEveryDays: 7 })).toBe('full');
  });

  it('only quick scans so far → full', () => {
    expect(scanDecision({ now, pollIntervalS: 21600, lastCompletedAt: at(7 * H), lastFullCompletedAt: null, running: false, fullEveryDays: 7 })).toBe('full');
  });

  it('a scan is running → nothing, whatever is due', () => {
    expect(scanDecision({ now, pollIntervalS: 21600, lastCompletedAt: null, lastFullCompletedAt: null, running: true, fullEveryDays: 7 })).toBeNull();
  });

  it('exactly at the boundary counts as due', () => {
    expect(scanDecision({ now, pollIntervalS: 21600, lastCompletedAt: at(6 * H), lastFullCompletedAt: at(1 * D), running: false, fullEveryDays: 7 })).toBe('quick');
  });
});

describe('STALE_RUNNING_MS', () => {
  it('is long enough for a full walk of a large NFS root and short enough to unblock within a day', async () => {
    const { STALE_RUNNING_MS } = await import('./scanSweep.js');
    expect(STALE_RUNNING_MS).toBeGreaterThanOrEqual(6 * H);
    expect(STALE_RUNNING_MS).toBeLessThanOrEqual(24 * H);
  });
});

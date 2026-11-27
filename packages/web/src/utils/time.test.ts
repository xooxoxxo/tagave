/**
 * The banner's "since" time: the clock alone on the same local day, the
 * short date and time otherwise. Inputs are local-time strings (no Z), so the
 * results hold in every time zone.
 */
import { describe, expect, it } from 'vitest';
import { shortDate, sinceLabel } from './time';

const now = new Date('2026-11-24T16:00:00');

describe('sinceLabel', () => {
  it('the same day: the clock, 24 h', () => {
    expect(sinceLabel('2026-11-24T14:02:00', now)).toBe('14:02');
    expect(sinceLabel('2026-11-24T00:05:00', now)).toBe('00:05');
  });

  it('another day: the short date and time', () => {
    expect(sinceLabel('2026-11-23T09:10:00', now)).toBe('23 Nov, 09:10');
    expect(sinceLabel('2025-03-03T09:10:00', now)).toBe('3 Mar 2025, 09:10');
  });

  it('not a time: as given', () => {
    expect(sinceLabel('soon', now)).toBe('soon');
  });
});

describe('shortDate', () => {
  it('the year only when it is not the year of now', () => {
    expect(shortDate('2026-11-23T09:10:00', { now })).toBe('23 Nov, 09:10');
    expect(shortDate('2025-03-03T09:10:00', { now, time: false })).toBe('3 Mar 2025');
  });
});

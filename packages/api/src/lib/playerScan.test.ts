import { describe, it, expect } from 'vitest';
import { hasScanned, scanPercent } from './player.js';

describe('the player server scan', () => {
  it('counts a lastScan only when the server really recorded one', () => {
    expect(hasScanned(null)).toBe(false);
    expect(hasScanned('')).toBe(false);
    // Navidrome before its first scan ends
    expect(hasScanned('0001-01-01T00:00:00Z')).toBe(false);
    expect(hasScanned('not a date')).toBe(false);
    expect(hasScanned('2026-10-15T21:00:00Z')).toBe(true);
  });

  it('turns count / total into a whole percent held under 100 while scanning', () => {
    expect(scanPercent(9500, 28000)).toBe(33);
    expect(scanPercent(0, 28000)).toBe(0);
    expect(scanPercent(30000, 28000)).toBe(99);
    expect(scanPercent(null, 28000)).toBeNull();
    expect(scanPercent(10, 0)).toBeNull();
    expect(scanPercent(10, null)).toBeNull();
  });
});

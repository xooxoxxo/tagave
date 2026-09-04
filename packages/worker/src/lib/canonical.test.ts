/**
 * Tests for pure canonical functions.
 */
import { describe, it, expect } from 'vitest';
import { normDate, buildLabelsJsonb, buildMediaJsonb } from './canonical.js';

describe('normDate', () => {
  it('handles null/undefined', () => {
    expect(normDate(undefined)).toBe(null);
    expect(normDate('')).toBe(null);
  });

  it('converts YYYY to YYYY-01-01', () => {
    expect(normDate('2000')).toBe('2000-01-01');
    expect(normDate('1999')).toBe('1999-01-01');
  });

  it('converts YYYY-MM to YYYY-MM-01', () => {
    expect(normDate('2000-03')).toBe('2000-03-01');
    expect(normDate('1999-12')).toBe('1999-12-01');
  });

  it('passes through YYYY-MM-DD', () => {
    expect(normDate('2000-03-15')).toBe('2000-03-15');
    expect(normDate('1999-12-31')).toBe('1999-12-31');
  });

  it('rejects invalid formats', () => {
    expect(normDate('2000-13')).toBe('2000-13-01'); // Naive: pads even invalid months
    expect(normDate('abc')).toBe(null);
    expect(normDate('2000-03-32')).toBe('2000-03-32'); // Naive: passes through
  });
});

describe('buildLabelsJsonb', () => {
  it('uses labels array if present', () => {
    const labels = [{ name: 'Label A', catalogNumber: 'CAT-001' }];
    expect(buildLabelsJsonb(labels)).toEqual(labels);
  });

  it('uses fallback if labels empty', () => {
    expect(buildLabelsJsonb([], 'Fallback Label')).toEqual([{ name: 'Fallback Label' }]);
  });

  it('uses fallback if labels undefined', () => {
    expect(buildLabelsJsonb(undefined, 'Fallback Label')).toEqual([{ name: 'Fallback Label' }]);
  });

  it('returns empty if no labels and no fallback', () => {
    expect(buildLabelsJsonb([])).toEqual([]);
    expect(buildLabelsJsonb(undefined)).toEqual([]);
  });

  it('handles multiple labels', () => {
    const labels = [
      { name: 'Label A' },
      { name: 'Label B', catalogNumber: 'CAT-002' },
    ];
    expect(buildLabelsJsonb(labels)).toEqual(labels);
  });
});

describe('buildMediaJsonb', () => {
  it('uses mediaList if present', () => {
    const mediaList = [
      { position: 1, format: 'CD', trackCount: 12 },
      { position: 2, format: 'CD', trackCount: 10 },
    ];
    const result = buildMediaJsonb(mediaList);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ position: 1, format: 'CD', trackCount: 12 });
  });

  it('uses fallback if mediaList empty', () => {
    expect(buildMediaJsonb([], 'Vinyl')).toEqual([{ position: 1, format: 'Vinyl' }]);
  });

  it('uses fallback if mediaList undefined', () => {
    expect(buildMediaJsonb(undefined, 'CD')).toEqual([{ position: 1, format: 'CD' }]);
  });

  it('returns empty if no mediaList and no fallback', () => {
    expect(buildMediaJsonb([])).toEqual([]);
    expect(buildMediaJsonb(undefined)).toEqual([]);
  });

  it('omits trackCount if zero or undefined', () => {
    const mediaList = [
      { position: 1, format: 'CD', trackCount: 0 },
      { position: 2, format: 'Vinyl', trackCount: 10 },
    ];
    const result = buildMediaJsonb(mediaList);
    expect(result[0]).toEqual({ position: 1, format: 'CD' });
    expect(result[1]).toEqual({ position: 2, format: 'Vinyl', trackCount: 10 });
  });
});

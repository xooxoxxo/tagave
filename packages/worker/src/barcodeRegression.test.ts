import { describe, it, expect } from 'vitest';
import { barcodeKind, legacyBreakdown, parseCliArgs } from './barcodeRegression.js';

describe('barcodeKind', () => {
  it('tells a formatting difference from a real mismatch', () => {
    expect(barcodeKind('0123', undefined)).toBe('not_stored');
    expect(barcodeKind('0123', '0123')).toBe('match');
    expect(barcodeKind('012345678905', '0012345678905')).toBe('format_only');
    expect(barcodeKind('0 12345 67890 5', '012345678905')).toBe('format_only');
    expect(barcodeKind('0123', '9999')).toBe('mismatch');
    expect(barcodeKind('none', '0123')).toBe('unusable');
  });
});

describe('legacyBreakdown (the rule before the fix)', () => {
  it('a match painted the album-id chip green, even over an embedded-id mismatch', () => {
    expect(legacyBreakdown({ albumId: 1 }, '0123', '0123')['albumId']).toBe(0);
    expect(legacyBreakdown({}, '0123', '0123')['albumId']).toBe(0);
  });
  it('a mismatch added 0.3 on top of whatever was there', () => {
    expect(legacyBreakdown({ albumId: 1 }, '0123', '9999')['albumId']).toBeCloseTo(1.3);
    expect(legacyBreakdown({}, '0123', '9999')['albumId']).toBeCloseTo(0.3);
  });
  it('compared barcodes as written, so formatting or junk counted as a mismatch', () => {
    expect(legacyBreakdown({}, 'none', '0123')['albumId']).toBeCloseTo(0.3);
    expect(legacyBreakdown({}, '012345678905', '0012345678905')['albumId']).toBeCloseTo(0.3);
  });
  it('left the breakdown alone without a barcode on both sides', () => {
    expect(legacyBreakdown({ artist: 0 }, '0123', undefined)).toEqual({ artist: 0 });
  });
});

describe('parseCliArgs', () => {
  it('reads the flags', () => {
    expect(parseCliArgs([])).toEqual({});
    expect(parseCliArgs(['--library', 'abc', '--limit', '20', '--out', 'r.md', '--json', 'r.json']))
      .toEqual({ library: 'abc', limit: 20, out: 'r.md', json: 'r.json' });
  });
  it('refuses bad usage', () => {
    for (const bad of [['--limit', '0'], ['--limit', '-3'], ['--limit', '2.5'], ['--limit', 'x'], ['--out'], ['--library', '--limit', '3'], ['--verbose', 'x'], ['stray']]) {
      expect(parseCliArgs(bad)).toBeNull();
    }
  });
});

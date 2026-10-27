import { describe, it, expect } from 'vitest';
import { barcodeKind } from './barcodeRegression.js';

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

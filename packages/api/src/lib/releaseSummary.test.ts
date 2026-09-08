import { describe, it, expect } from 'vitest';
import { mediaSummary, labelSummary } from './releaseSummary.js';

describe('mediaSummary', () => {
  it('groups media by format', () => {
    expect(mediaSummary([{ position: 1, format: 'CD' }])).toBe('CD');
    expect(mediaSummary([{ position: 1, format: '12" Vinyl' }, { position: 2, format: '12" Vinyl' }])).toBe('2×12" Vinyl');
    expect(mediaSummary([{ position: 1, format: 'CD' }, { position: 2, format: 'DVD' }])).toBe('CD + DVD');
  });

  it('names unknown formats and returns null for nothing', () => {
    expect(mediaSummary([{ position: 1 }])).toBe('Unknown');
    expect(mediaSummary([])).toBeNull();
    expect(mediaSummary(null)).toBeNull();
    expect(mediaSummary('CD')).toBeNull();
  });
});

describe('labelSummary', () => {
  it('joins the first label and catalogue number', () => {
    expect(labelSummary([{ name: 'Harvest', catalogNumber: 'SHVL 804' }, { name: 'EMI' }])).toBe('Harvest · SHVL 804');
    expect(labelSummary([{ name: 'Harvest' }])).toBe('Harvest');
    expect(labelSummary([{ catalogNumber: 'SHVL 804' }])).toBe('SHVL 804');
    expect(labelSummary([{ name: 'Old', catno: 'X-1' }])).toBe('Old · X-1');
  });

  it('returns null for empty or malformed input', () => {
    expect(labelSummary([])).toBeNull();
    expect(labelSummary([{}])).toBeNull();
    expect(labelSummary(undefined)).toBeNull();
  });
});

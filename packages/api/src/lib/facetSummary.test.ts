import { describe, expect, it } from 'vitest';
import { summaryConds, summaryEligible } from './facetSummary.js';

describe('summaryEligible', () => {
  it('accepts the rail dimensions and paging keys', () => {
    expect(summaryEligible({})).toBe(true);
    expect(summaryEligible({ state: ['matched', 'pending'], genre: 'Rock', decade: '1990', format: ['lossless', 'flac'], label: 'Warp', owned: 'both', gap: 'none', sort: 'artist', page: '2', view: 'grid' })).toBe(true);
    expect(summaryEligible({ state: 'all', q: '' })).toBe(true);
  });

  it('falls back to the live path for filters the table does not carry', () => {
    expect(summaryEligible({ q: 'floyd' })).toBe(false);
    expect(summaryEligible({ search: 'floyd' })).toBe(false);
    expect(summaryEligible({ artist: 'Pink Floyd' })).toBe(false);
    expect(summaryEligible({ review: 'reviewed' })).toBe(false);
    expect(summaryEligible({ decided: 'chip_rule' })).toBe(false);
  });
});

describe('summaryConds', () => {
  const lib = '01a05c38-c7d3-7d58-b32a-0f0ecc428e64';
  const count = (q: Record<string, unknown>, omit?: Parameters<typeof summaryConds>[2]) => summaryConds(lib, q, omit).length;

  it('always scopes to the library', () => {
    expect(count({})).toBe(1);
  });

  it('adds one predicate per active dimension and drops the omitted one', () => {
    const q = { state: 'matched', genre: ['Rock', 'Jazz'], decade: '1990', format: 'lossless', label: 'Warp', owned: 'digital', gap: ['none', 'quality'] };
    expect(count(q)).toBe(8);
    expect(count(q, 'genre')).toBe(7);
    expect(count(q, 'state')).toBe(7);
  });

  it('treats state=all, empty values and unknown owned values as no filter', () => {
    expect(count({ state: 'all', genre: '', owned: 'all' })).toBe(1);
    expect(count({ filter: 'pending' })).toBe(2);
    expect(count({ filter: 'pending' }, 'state')).toBe(1);
  });
});

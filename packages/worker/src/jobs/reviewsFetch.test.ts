import { describe, it, expect } from 'vitest';
import { artistCreditString, ratingNormalized } from './reviewsFetch.js';

describe('ratingNormalized', () => {
  it('maps a provider scale onto 0–100', () => {
    expect(ratingNormalized(4.55, 5)).toBe(91);
    expect(ratingNormalized(3.86, 5)).toBe(77);
    expect(ratingNormalized(8.6, 10)).toBe(86);
    expect(ratingNormalized(5, 5)).toBe(100);
  });

  it('is null without a rating or scale', () => {
    expect(ratingNormalized(null, 5)).toBeNull();
    expect(ratingNormalized(undefined, 5)).toBeNull();
    expect(ratingNormalized(4, null)).toBeNull();
    expect(ratingNormalized(4, 0)).toBeNull();
  });
});

describe('artistCreditString', () => {
  it('joins the jsonb artist credit', () => {
    expect(artistCreditString(['Radiohead'])).toBe('Radiohead');
    expect(artistCreditString(['A', 'B'])).toBe('A, B');
    expect(artistCreditString('Solo')).toBe('Solo');
    expect(artistCreditString(null)).toBe('');
  });
});

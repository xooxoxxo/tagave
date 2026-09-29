import { describe, it, expect } from 'vitest';
import { centeredScrollLeft } from './scroll';

describe('centeredScrollLeft', () => {
  // a 360px row holding 1000px of links
  it('centres an item in the middle of the row', () => {
    expect(centeredScrollLeft(1000, 360, 500, 100)).toBe(370);
  });
  it('does not scroll past the start for the first items', () => {
    expect(centeredScrollLeft(1000, 360, 0, 120)).toBe(0);
  });
  it('does not scroll past the end for the last items', () => {
    expect(centeredScrollLeft(1000, 360, 900, 100)).toBe(640);
  });
  it('never scrolls a row that fits', () => {
    expect(centeredScrollLeft(300, 360, 200, 100)).toBe(0);
  });
});

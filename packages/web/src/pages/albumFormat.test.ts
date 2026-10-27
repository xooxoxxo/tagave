import { describe, expect, it } from 'vitest';
import { totalLength } from './albumFormat';

describe('totalLength', () => {
  it('shows minutes and hours', () => {
    expect(totalLength(38 * 60000)).toBe('38 min');
    expect(totalLength(72 * 60000)).toBe('1 hr 12 min');
  });

  it('an album that would round to "0 min" shows its seconds (QA Q-25)', () => {
    expect(totalLength(18_000)).toBe('0:18');
    expect(totalLength(29_600)).toBe('0:30');
  });
});

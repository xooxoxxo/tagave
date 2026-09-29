import { describe, it, expect } from 'vitest';
import { grownPlanName } from './planName.js';

describe('grownPlanName', () => {
  it('renames a one-album wizard name once a second album joins', () => {
    expect(grownPlanName('Miles Davis — Kind of Blue tags', 1, 2, ['Kind of Blue'])).toBe(
      'Miles Davis — Kind of Blue + 1 more album tags',
    );
  });

  it('keeps counting on a name it grew before', () => {
    expect(grownPlanName('Miles Davis — Kind of Blue + 1 more album tags', 2, 4, ['Kind of Blue', 'Sketches'])).toBe(
      'Miles Davis — Kind of Blue + 3 more albums tags',
    );
  });

  it('updates the count in a several-albums wizard name', () => {
    expect(grownPlanName('3 albums tags', 3, 5, [])).toBe('5 albums tags');
  });

  it('leaves a name the user typed alone', () => {
    expect(grownPlanName('Jazz cleanup', 1, 2, ['Kind of Blue'])).toBeNull();
    expect(grownPlanName('Weekend tags', 1, 2, ['Kind of Blue'])).toBeNull();
  });

  it('does nothing when no album was added', () => {
    expect(grownPlanName('Miles Davis — Kind of Blue tags', 1, 1, ['Kind of Blue'])).toBeNull();
  });
});

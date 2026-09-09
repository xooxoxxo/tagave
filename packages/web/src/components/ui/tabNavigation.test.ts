import { describe, it, expect } from 'vitest';
import { nextTabIndex } from './tabNavigation';
describe('tab keyboard navigation', () => {
  it('wraps between the first and last tabs', () => {
    expect(nextTabIndex('ArrowLeft', 0, 3)).toBe(2);
    expect(nextTabIndex('ArrowRight', 2, 3)).toBe(0);
  });
  it('supports Home and End independently of current selection', () => {
    expect(nextTabIndex('Home', 2, 3)).toBe(0);
    expect(nextTabIndex('End', 0, 3)).toBe(2);
  });
  it('does not intercept unrelated keys or empty tab lists', () => {
    expect(nextTabIndex('Tab', 0, 3)).toBeUndefined();
    expect(nextTabIndex('ArrowRight', 0, 0)).toBeUndefined();
  });
});

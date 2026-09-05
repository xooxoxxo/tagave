import { describe, it, expect } from 'vitest';
import { formatDuration } from '../src/checks.js';

describe('checks', () => {
  describe('formatDuration', () => {
    it('formats milliseconds for small durations', () => {
      expect(formatDuration(100)).toBe('100ms');
      expect(formatDuration(999)).toBe('999ms');
    });

    it('formats seconds for durations >= 1 second', () => {
      expect(formatDuration(1000)).toBe('1.0s');
      expect(formatDuration(1500)).toBe('1.5s');
      expect(formatDuration(5234)).toBe('5.2s');
    });

    it('handles zero duration', () => {
      expect(formatDuration(0)).toBe('0ms');
    });

    it('handles large durations', () => {
      expect(formatDuration(60000)).toBe('60.0s');
      expect(formatDuration(125000)).toBe('125.0s');
    });
  });
});

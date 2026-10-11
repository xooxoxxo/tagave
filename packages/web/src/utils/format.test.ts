import { describe, expect, it } from 'vitest';
import { formatBytes } from './format';

describe('formatBytes', () => {
  it('shows whole bytes without a fraction', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(256)).toBe('256 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('shows larger sizes with one decimal', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB');
  });
});

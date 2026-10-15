import { describe, expect, it } from 'vitest';
import { defaultCacheDir } from './cacheDir.js';

describe('defaultCacheDir', () => {
  it('is ~/tagave-cache on a new home', () => {
    expect(defaultCacheDir('/home/u', () => false)).toBe('/home/u/tagave-cache');
  });
  it('keeps the pre-0.9 ~/liner-cache when only that one exists', () => {
    expect(defaultCacheDir('/home/u', (p) => p === '/home/u/liner-cache')).toBe('/home/u/liner-cache');
  });
  it('prefers ~/tagave-cache once it exists', () => {
    expect(defaultCacheDir('/home/u', () => true)).toBe('/home/u/tagave-cache');
  });
});

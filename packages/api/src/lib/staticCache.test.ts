import { describe, expect, it } from 'vitest';
import { staticCacheControl } from './staticCache.js';

describe('staticCacheControl', () => {
  it('caches hashed build assets for a year', () => {
    expect(staticCacheControl('/app/packages/web/dist/assets/index-BWtJk8zk.js')).toBe('public, max-age=31536000, immutable');
    expect(staticCacheControl('/app/packages/web/dist/assets/figtree-latin-400-normal-g7Dtegnw.woff2')).toContain('immutable');
  });

  it('revalidates the app shell and unhashed files', () => {
    expect(staticCacheControl('/app/packages/web/dist/index.html')).toBe('no-cache');
    expect(staticCacheControl('/app/packages/web/dist/tagave-mark.svg')).toBe('no-cache');
  });
});

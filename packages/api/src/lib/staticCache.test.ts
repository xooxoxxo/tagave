import { describe, expect, it } from 'vitest';
import { isNoStorePath, servesAppShell, staticCacheControl } from './staticCache.js';

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

describe('servesAppShell', () => {
  it('answers deep links with the app shell', () => {
    expect(servesAppShell('GET', '/albums')).toBe(true);
    expect(servesAppShell('GET', '/settings/updates?x=1')).toBe(true);
    expect(servesAppShell('GET', '/')).toBe(true);
  });

  it('never for the API, other methods, or a missing build asset', () => {
    expect(servesAppShell('GET', '/api/v1/nope')).toBe(false);
    expect(servesAppShell('POST', '/albums')).toBe(false);
    expect(servesAppShell('GET', '/assets/PlansPage-OLDHASH.js')).toBe(false);
    expect(servesAppShell('GET', '/assets/PlansPage-OLDHASH.css?v=1')).toBe(false);
  });

  it('never for the Music Connections feeds or discovery: another app reads them', () => {
    expect(servesAppShell('GET', '/mc/v1/nope')).toBe(false);
    expect(servesAppShell('GET', '/mc/v1/ratings?since=x')).toBe(false);
    expect(servesAppShell('GET', '/MC/v1/ratings')).toBe(false);
    expect(servesAppShell('GET', '/mc')).toBe(false);
    expect(servesAppShell('GET', '/.well-known/nope')).toBe(false);
    expect(servesAppShell('GET', '/.well-known')).toBe(false);
    // a page whose name only starts the same is still a deep link
    expect(servesAppShell('GET', '/mcollection')).toBe(true);
  });
});

describe('isNoStorePath', () => {
  it('is the /mc tree only', () => {
    expect(isNoStorePath('/mc/v1/x?y=1')).toBe(true);
    expect(isNoStorePath('/mc')).toBe(true);
    expect(isNoStorePath('/mcollection')).toBe(false);
    expect(isNoStorePath('/api/v1/x')).toBe(false);
  });
});

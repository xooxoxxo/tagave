/**
 * Community ratings (spec REV-1): MusicBrainz release-group rating
 * (CC BY-NC-SA 3.0) and the Discogs community rating (6 h freshness).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { MusicBrainzProvider } from './musicbrainz.js';
import { DiscogsProvider } from './discogs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const loadFixture = (name: string) => JSON.parse(readFileSync(join(__dirname, '__fixtures__', name), 'utf-8'));
const ctx = { priority: 'background' as const };

describe('MusicBrainzProvider.getReleaseGroupRating', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads value and votes from inc=ratings', async () => {
    let seenUrl = '';
    vi.stubGlobal('fetch', async (url: string) => {
      seenUrl = url;
      return new Response(JSON.stringify(loadFixture('mb_rg_ratings_okcomputer.json')), { status: 200 });
    });
    const mb = new MusicBrainzProvider('Liner/test (+test)');

    const rating = await mb.getReleaseGroupRating('b1392450-e666-3926-a536-22c65f834433', ctx);

    expect(seenUrl).toContain('/ws/2/release-group/b1392450-e666-3926-a536-22c65f834433');
    expect(seenUrl).toContain('inc=ratings');
    expect(rating).toEqual({ value: 4.55, votes: 88 });
  });

  it('returns a null value when the group has no votes, and throws on 503', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ id: 'x', title: 'X', rating: { 'votes-count': 0, value: null } }), { status: 200 }));
    expect(await new MusicBrainzProvider('t').getReleaseGroupRating('x', ctx)).toEqual({ value: null, votes: 0 });

    vi.stubGlobal('fetch', async () => new Response('', { status: 503 }));
    await expect(new MusicBrainzProvider('t').getReleaseGroupRating('x', ctx)).rejects.toThrow(/503/);
  });
});

describe('DiscogsProvider.getCommunityRating', () => {
  it('reads community.rating from the release payload', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify(loadFixture('discogs_release_249504.json')), { status: 200 })) as unknown as typeof fetch;
    const discogs = new DiscogsProvider({ userAgent: 't', fetchImpl });
    expect(await discogs.getCommunityRating('249504', ctx)).toEqual({ average: 3.86, count: 241 });
  });

  it('returns null when the payload carries no community block', async () => {
    const raw = { ...loadFixture('discogs_release_249504.json') };
    delete raw.community;
    const fetchImpl = (async () => new Response(JSON.stringify(raw), { status: 200 })) as unknown as typeof fetch;
    expect(await new DiscogsProvider({ userAgent: 't', fetchImpl }).getCommunityRating('249504', ctx)).toBeNull();
  });
});

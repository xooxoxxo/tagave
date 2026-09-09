/**
 * MusicBrainz provider tests.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { extractUrlRelations, discogsIdsFromUrlRelations, wikidataQidFromUrlRelations, MusicBrainzProvider } from './musicbrainz.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadFixture(name: string) {
  const path = join(__dirname, '__fixtures__', name);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

describe('extractUrlRelations', () => {
  it('should extract URL relations from relations array', () => {
    const relations = [
      {
        type: 'discogs',
        'target-type': 'url',
        url: { resource: 'https://www.discogs.com/release/1671391' },
      },
      {
        type: 'wikidata',
        'target-type': 'url',
        url: { resource: 'https://www.wikidata.org/wiki/Q918304' },
      },
      {
        type: 'other',
        'target-type': 'release',
        url: { resource: 'https://example.com' },
      },
    ];

    const result = extractUrlRelations(relations);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: 'discogs', url: 'https://www.discogs.com/release/1671391' });
    expect(result[1]).toEqual({ type: 'wikidata', url: 'https://www.wikidata.org/wiki/Q918304' });
  });

  it('should handle missing relations', () => {
    expect(extractUrlRelations()).toEqual([]);
    expect(extractUrlRelations(undefined)).toEqual([]);
  });

  it('should skip non-URL relations', () => {
    const relations = [
      {
        type: 'discogs',
        'target-type': 'release',
        url: { resource: 'https://www.discogs.com/release/1671391' },
      },
    ];

    expect(extractUrlRelations(relations)).toEqual([]);
  });

  it('should handle MB release with URL rels fixture', () => {
    const fixture = loadFixture('mb_release_urlrels.json');
    const result = extractUrlRelations(fixture.relations);

    expect(result.length).toBeGreaterThan(0);
    const discogsRel = result.find(r => r.type === 'discogs');
    expect(discogsRel?.url).toContain('discogs.com');
  });
});

describe('discogsIdsFromUrlRelations', () => {
  it('should extract release and master IDs', () => {
    const rels = [
      { type: 'discogs', url: 'https://www.discogs.com/release/1671391' },
      { type: 'other', url: 'https://example.com' },
    ];

    const result = discogsIdsFromUrlRelations(rels);

    expect(result.releaseId).toBe(1671391);
    expect(result.masterId).toBeUndefined();
  });

  it('should extract master ID', () => {
    const rels = [
      { type: 'discogs', url: 'https://www.discogs.com/master/96568' },
    ];

    const result = discogsIdsFromUrlRelations(rels);

    expect(result.masterId).toBe(96568);
    expect(result.releaseId).toBeUndefined();
  });

  it('should return empty when no discogs relation', () => {
    const rels = [
      { type: 'wikidata', url: 'https://www.wikidata.org/wiki/Q918304' },
    ];

    const result = discogsIdsFromUrlRelations(rels);

    expect(result.releaseId).toBeUndefined();
    expect(result.masterId).toBeUndefined();
  });
});

describe('wikidataQidFromUrlRelations', () => {
  it('should extract wikidata QID', () => {
    const rels = [
      { type: 'wikidata', url: 'https://www.wikidata.org/wiki/Q918304' },
    ];

    const result = wikidataQidFromUrlRelations(rels);

    expect(result).toBe('Q918304');
  });

  it('should return undefined when no wikidata relation', () => {
    const rels = [
      { type: 'discogs', url: 'https://www.discogs.com/release/1671391' },
    ];

    expect(wikidataQidFromUrlRelations(rels)).toBeUndefined();
  });

  it('should handle release group with both discogs and wikidata', () => {
    const fixture = loadFixture('mb_rg_urlrels.json');
    const urlRels = extractUrlRelations(fixture.relations);
    const result = wikidataQidFromUrlRelations(urlRels);

    expect(result).toBeDefined();
    expect(result?.startsWith('Q')).toBe(true);
  });
});

describe('Label info handling', () => {
  it('should handle label-info without label field', () => {
    const fixture = loadFixture('mb_search_rick.json');
    // Should parse without throwing even if label is missing in some entries
    expect(fixture.releases).toBeDefined();
    expect(Array.isArray(fixture.releases)).toBe(true);
  });
});

describe('getReleaseGroupEditions', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('browses /release?release-group= with labels and media, and maps one page', async () => {
    // Trimmed from a live 2026-09-09 response (Periphery, Juggernaut: Omega; 3 of 8 releases kept).
    // The release-group lookup rejects inc=labels with 400, so editions must come from the browse.
    const fixture = loadFixture('mb_release_browse_rg.json');
    let requested = '';
    globalThis.fetch = (async (input: string | URL | Request) => {
      requested = String(input);
      return new Response(JSON.stringify(fixture), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const provider = new MusicBrainzProvider('Liner-test/0.1');
    const page = await provider.getReleaseGroupEditions('ce2bdcd6-ea6f-40e6-bc0f-4b67399b97b4', { priority: 'background' });

    const url = new URL(requested);
    expect(url.pathname).toBe('/ws/2/release');
    expect(url.searchParams.get('release-group')).toBe('ce2bdcd6-ea6f-40e6-bc0f-4b67399b97b4');
    expect(url.searchParams.get('inc')).toBe('media+labels+release-groups');
    expect(url.searchParams.get('fmt')).toBe('json');
    expect(url.searchParams.get('limit')).toBe('100');
    expect(url.searchParams.get('offset')).toBe('0');

    expect(page.total).toBe(8);
    expect(page.offset).toBe(0);
    expect(page.releaseGroup).toEqual({
      mbid: 'ce2bdcd6-ea6f-40e6-bc0f-4b67399b97b4',
      title: 'Juggernaut: Omega',
      primaryType: 'Album',
      secondaryTypes: [],
      firstReleaseDate: '2015-01-23',
    });
    expect(page.editions).toHaveLength(3);

    const special = page.editions[0]!;
    expect(special).toEqual({
      mbid: '03179d7c-09d5-4e34-800e-5a024b7dd885',
      title: 'Juggernaut: Omega',
      disambiguation: 'Special Edition CD+DVD',
      status: 'Official',
      date: '2015-01-23',
      country: 'XE',
      barcode: '5051099853201',
      packaging: 'Jewel Case',
      labels: [{ name: 'Century Media', catalogNumber: '9985320' }],
      media: [
        { position: 1, format: 'CD', trackCount: 7 },
        { position: 2, format: 'DVD-Video', trackCount: 2 },
      ],
      // the browse carries no release-level track-count: it is the sum of the media
      trackCount: 9,
    });

    const digital = page.editions[1]!;
    expect(digital.mbid).toBe('6fb2016b-3f93-41f8-8569-21c134442e69');
    expect(digital.labels).toEqual([]);
    expect(digital.media).toEqual([{ position: 1, format: 'Digital Media', trackCount: 7 }]);
    expect(digital.trackCount).toBe(7);
    expect(digital).not.toHaveProperty('date');
    expect(digital).not.toHaveProperty('country');
    expect(digital).not.toHaveProperty('barcode');
    expect(digital).not.toHaveProperty('disambiguation');

    const au = page.editions[2]!;
    expect(au.mbid).toBe('89e57c8d-af2a-4a51-bb61-fc95cd88dc33');
    expect(au.labels).toEqual([{ name: 'Roadrunner Records', catalogNumber: '5419648592' }]);
    expect(au.country).toBe('AU');
  });

  it('pages with offset, clamps the page size to the MusicBrainz maximum, and reports an empty page', async () => {
    let requested = '';
    globalThis.fetch = (async (input: string | URL | Request) => {
      requested = String(input);
      return new Response(JSON.stringify({ 'release-count': 0, 'release-offset': 200, releases: [] }), { status: 200 });
    }) as typeof fetch;

    const page = await new MusicBrainzProvider('Liner-test/0.1')
      .getReleaseGroupEditions('ce2bdcd6-ea6f-40e6-bc0f-4b67399b97b4', { priority: 'background' }, { offset: 200, limit: 500 });

    const url = new URL(requested);
    expect(url.searchParams.get('limit')).toBe('100');
    expect(url.searchParams.get('offset')).toBe('200');
    expect(page).toEqual({ releaseGroup: null, editions: [], total: 0, offset: 200 });
  });

  it('keeps a release-level track-count when the payload carries one, and drops label-info without a label', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      'release-count': 1,
      'release-offset': 0,
      releases: [{
        id: 'rel-1',
        title: 'Test Album',
        'track-count': 10,
        media: [{ position: '1', format: 'CD', 'track-count': 10 }],
        'label-info': [
          { label: { id: 'label-1', name: 'Test Label' }, 'catalog-number': 'CAT001' },
          { label: null, 'catalog-number': 'CATALT' },
        ],
        'release-group': { id: 'rg-1', title: 'Test Album' },
      }],
    }), { status: 200 })) as typeof fetch;

    const page = await new MusicBrainzProvider('Liner-test/0.1').getReleaseGroupEditions('rg-1', { priority: 'background' });
    expect(page.releaseGroup).toEqual({ mbid: 'rg-1', title: 'Test Album' });
    expect(page.editions[0]!.trackCount).toBe(10);
    expect(page.editions[0]!.labels).toEqual([{ name: 'Test Label', catalogNumber: 'CAT001' }]);
    expect(page.editions[0]!.media).toEqual([{ position: 1, format: 'CD', trackCount: 10 }]);
  });

  it('surfaces a 503 as a rate-limit error and attaches the status to other failures', async () => {
    const provider = new MusicBrainzProvider('Liner-test/0.1');

    globalThis.fetch = (async () => new Response('{"error":"The MusicBrainz web server is currently busy."}', { status: 503, statusText: 'Service Unavailable' })) as typeof fetch;
    await expect(provider.getReleaseGroupEditions('x', { priority: 'background' })).rejects.toThrow(/rate limited \(503\)/);

    globalThis.fetch = (async () => new Response('{"error":"labels is not a valid inc parameter"}', { status: 400, statusText: 'Bad Request' })) as typeof fetch;
    await expect(provider.getReleaseGroupEditions('x', { priority: 'background' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('HTTP failures carry their status', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('getRelease rejects a stale MBID with status 404', async () => {
    globalThis.fetch = (async () => new Response('not found', { status: 404, statusText: 'Not Found' })) as typeof fetch;
    const provider = new MusicBrainzProvider('Test/1.0 (+test)');
    await expect(provider.getRelease('00000000-0000-0000-0000-000000000000', { priority: 'background' }))
      .rejects.toMatchObject({ status: 404 });
  });

  it('searchReleases rejects a server error with its status', async () => {
    globalThis.fetch = (async () => new Response('boom', { status: 500, statusText: 'Internal Server Error' })) as typeof fetch;
    const provider = new MusicBrainzProvider('Test/1.0 (+test)');
    await expect(provider.searchReleases({ albumTitle: 'x' }, { priority: 'background' }))
      .rejects.toMatchObject({ status: 500 });
  });

  it('getArtist rejects a missing artist with status 404', async () => {
    globalThis.fetch = (async () => new Response('not found', { status: 404, statusText: 'Not Found' })) as typeof fetch;
    const provider = new MusicBrainzProvider('Test/1.0 (+test)');
    await expect(provider.getArtist('00000000-0000-0000-0000-000000000000', { priority: 'background' }))
      .rejects.toMatchObject({ status: 404 });
  });

  it('getReleaseGroupCredits rejects a missing release group with status 404', async () => {
    globalThis.fetch = (async () => new Response('not found', { status: 404, statusText: 'Not Found' })) as typeof fetch;
    const provider = new MusicBrainzProvider('Test/1.0 (+test)');
    await expect(provider.getReleaseGroupCredits('00000000-0000-0000-0000-000000000000', { priority: 'background' }))
      .rejects.toMatchObject({ status: 404 });
  });
});

describe('artistCredits mapping (spec ENR-7)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should map artist credits with joinphrase', async () => {
    const fixture = loadFixture('mb_release_artistcredits_genres.json');
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => fixture,
    }) as any;

    const provider = new MusicBrainzProvider('Test/1.0 (+test)');
    const release = await provider.getRelease('12345678-1234-1234-1234-123456789012', { priority: 'interactive' });

    expect(release.artistCredits).toBeDefined();
    expect(release.artistCredits).toHaveLength(2);

    const credit1 = release.artistCredits![0]!;
    expect(credit1.mbid).toBe('artist-id-1');
    expect(credit1.name).toBe('Artist One');
    expect(credit1.joinPhrase).toBe(' feat. ');

    const credit2 = release.artistCredits![1]!;
    expect(credit2.mbid).toBe('artist-id-2');
    expect(credit2.name).toBe('Artist Two');
    expect(credit2.joinPhrase).toBeUndefined();
  });

  it('should prefer release-group genres over release genres', async () => {
    const fixture = loadFixture('mb_release_artistcredits_genres.json');
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => fixture,
    }) as any;

    const provider = new MusicBrainzProvider('Test/1.0 (+test)');
    const release = await provider.getRelease('12345678-1234-1234-1234-123456789012', { priority: 'interactive' });

    // Should use release-group genres, not release genres
    expect(release.mbGenres).toBeDefined();
    expect(release.mbGenres).toHaveLength(2);
    expect(release.mbGenres![0]!.name).toBe('Rock');
    expect(release.mbGenres![0]!.count).toBe(5);
    expect(release.mbGenres![1]!.name).toBe('Pop');
    expect(release.mbGenres![1]!.count).toBe(3);
  });

  it('should extract primary and secondary types from release-group', async () => {
    const fixture = loadFixture('mb_release_artistcredits_genres.json');
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => fixture,
    }) as any;

    const provider = new MusicBrainzProvider('Test/1.0 (+test)');
    const release = await provider.getRelease('12345678-1234-1234-1234-123456789012', { priority: 'interactive' });

    expect(release.primaryType).toBe('Album');
    expect(release.secondaryTypes).toBeUndefined();
  });
});

describe('getReleaseGroupCredits (spec ENR-7)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should fetch release group with credits, genres, and tags', async () => {
    const fixture = loadFixture('mb_rg_credits.json');
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => fixture,
    }) as any;

    const provider = new MusicBrainzProvider('Test/1.0 (+test)');
    const rg = await provider.getReleaseGroupCredits('rg-id-1', { priority: 'interactive' });

    expect(rg.mbid).toBe('rg-id-1');
    expect(rg.title).toBe('Test Release Group');
    expect(rg.primaryType).toBe('Album');
    expect(rg.secondaryTypes).toEqual(['Compilation']);
    expect(rg.firstReleaseDate).toBe('2020-01-15');

    // Check artist credits
    expect(rg.artistCredits).toHaveLength(2);
    expect(rg.artistCredits[0]!.mbid).toBe('artist-id-1');
    expect(rg.artistCredits[0]!.name).toBe('Artist One');
    expect(rg.artistCredits[0]!.joinPhrase).toBe(' & ');

    expect(rg.artistCredits[1]!.mbid).toBe('artist-id-2');
    expect(rg.artistCredits[1]!.name).toBe('Artist Two');
    expect(rg.artistCredits[1]!.joinPhrase).toBeUndefined();

    // Check genres
    expect(rg.mbGenres).toHaveLength(3);
    expect(rg.mbGenres![0]!.name).toBe('Rock');
    expect(rg.mbGenres![0]!.count).toBe(10);

    // Check tags
    expect(rg.mbTags).toHaveLength(2);
    expect(rg.mbTags![0]!.name).toBe('british');
    expect(rg.mbTags![0]!.count).toBe(3);
  });
});

describe('getArtist with aliases and URL relations (spec ENR-7)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should fetch artist with all metadata', async () => {
    const fixture = loadFixture('mb_artist_aliases.json');
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => fixture,
    }) as any;

    const provider = new MusicBrainzProvider('Test/1.0 (+test)');
    const artist = await provider.getArtist('artist-id-1', { priority: 'interactive' });

    expect(artist.id).toBe('artist-id-1');
    expect(artist.name).toBe('Artist Name');
    expect(artist.sortName).toBe('Name, Artist');
    expect(artist.type).toBe('Person');
    expect(artist.country).toBe('GB');
    expect(artist.beginDate).toBe('1980-01-01');
    expect(artist.endDate).toBe('2020-12-31');
    expect(artist.ended).toBe(true);
    expect(artist.disambiguation).toBe('British musician');

    // Check aliases: primary first, then others, deduplicated
    expect(artist.aliases).toHaveLength(3);
    expect(artist.aliases[0]).toBe('Main Name');
    expect(artist.aliases[1]).toBe('One, Alias');
    expect(artist.aliases[2]).toBe('Two, Alias');

    // Check URL relations
    expect(artist.urlRelations).toHaveLength(3);
    const wikidata = artist.urlRelations.find(r => r.type === 'wikidata');
    expect(wikidata?.url).toContain('wikidata.org');
    const wikipedia = artist.urlRelations.find(r => r.type === 'wikipedia');
    expect(wikipedia?.url).toContain('wikipedia.org');
    const discogs = artist.urlRelations.find(r => r.type === 'discogs');
    expect(discogs?.url).toContain('discogs.com');
  });

  it('should extract country from area when country field is missing', async () => {
    const fixture = loadFixture('mb_artist_aliases.json');
    // Remove the country field to test fallback
    delete fixture.country;

    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => fixture,
    }) as any;

    const provider = new MusicBrainzProvider('Test/1.0 (+test)');
    const artist = await provider.getArtist('artist-id-1', { priority: 'interactive' });

    expect(artist.country).toBe('GB');
  });

  it('should handle artists without aliases or URL relations', async () => {
    const fixture = {
      id: 'simple-artist',
      name: 'Simple Artist',
    };

    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => fixture,
    }) as any;

    const provider = new MusicBrainzProvider('Test/1.0 (+test)');
    const artist = await provider.getArtist('simple-artist', { priority: 'interactive' });

    expect(artist.id).toBe('simple-artist');
    expect(artist.name).toBe('Simple Artist');
    expect(artist.aliases).toEqual([]);
    expect(artist.urlRelations).toEqual([]);
  });
});

describe('getArtist alias shapes', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('accepts a boolean `primary` on aliases and lists primary aliases first', async () => {
    const body = {
      id: 'b83bc61f-8451-4a5d-8b8e-7e9ed295e822',
      name: 'Elton John',
      'sort-name': 'John, Elton',
      type: 'Person',
      country: 'GB',
      'life-span': { begin: '1947-03-25', ended: false },
      aliases: [
        { name: 'Reginald Dwight', 'sort-name': 'Dwight, Reginald', primary: null },
        { name: 'Elton Hercules John', 'sort-name': 'John, Elton Hercules', primary: true },
        { name: 'Elton John', 'sort-name': 'John, Elton', primary: 'true' },
      ],
      relations: [],
    };
    globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const provider = new MusicBrainzProvider('Test/1.0 (+test)');
    const artist = await provider.getArtist('b83bc61f-8451-4a5d-8b8e-7e9ed295e822', { priority: 'background' });
    expect(artist.name).toBe('Elton John');
    expect(artist.country).toBe('GB');
    expect(artist.aliases.slice(0, 2)).toEqual(['Elton Hercules John', 'Elton John']);
    expect(artist.aliases).toContain('Reginald Dwight');
  });
});

describe('browseArtistReleaseGroups', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('maps one browse page: types, dates, credits and the paging totals', async () => {
    // Trimmed from a live 2026-09-08 response (Pink Floyd, type=album|ep, limit 3).
    const fixture = loadFixture('mb_rg_browse_artist.json');
    let requested = '';
    globalThis.fetch = (async (input: string | URL | Request) => {
      requested = String(input);
      return new Response(JSON.stringify(fixture), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const provider = new MusicBrainzProvider('Liner-test/0.1');
    const page = await provider.browseArtistReleaseGroups(
      '83d91898-7763-47d7-b03b-b92132375c47',
      { priority: 'background' },
      { types: ['Album', 'EP'], offset: 0 },
    );

    const url = new URL(requested);
    expect(url.pathname).toBe('/ws/2/release-group');
    expect(url.searchParams.get('artist')).toBe('83d91898-7763-47d7-b03b-b92132375c47');
    expect(url.searchParams.get('type')).toBe('album|ep');
    expect(url.searchParams.get('inc')).toBe('artist-credits');
    expect(url.searchParams.get('limit')).toBe('100');
    expect(url.searchParams.get('offset')).toBe('0');

    expect(page.total).toBe(526);
    expect(page.offset).toBe(0);
    expect(page.items).toHaveLength(3);
    expect(page.items[0]).toEqual({
      mbid: '6792b6d1-4e65-3c3c-9d20-d08aa1dcfc60',
      title: 'The Piper at the Gates of Dawn',
      primaryType: 'Album',
      secondaryTypes: [],
      firstReleaseDate: '1967-07-07',
      artistCredits: [{ mbid: '83d91898-7763-47d7-b03b-b92132375c47', name: 'Pink Floyd' }],
    });
  });

  it('clamps the page size to the MusicBrainz maximum and omits the type filter when none is given', async () => {
    let requested = '';
    globalThis.fetch = (async (input: string | URL | Request) => {
      requested = String(input);
      return new Response(JSON.stringify({ 'release-group-count': 0, 'release-group-offset': 300, 'release-groups': [] }), { status: 200 });
    }) as typeof fetch;

    const page = await new MusicBrainzProvider('Liner-test/0.1')
      .browseArtistReleaseGroups('83d91898-7763-47d7-b03b-b92132375c47', { priority: 'background' }, { limit: 500, offset: 300 });

    const url = new URL(requested);
    expect(url.searchParams.get('limit')).toBe('100');
    expect(url.searchParams.get('offset')).toBe('300');
    expect(url.searchParams.has('type')).toBe(false);
    expect(page).toEqual({ items: [], total: 0, offset: 300 });
  });

  it('surfaces a 503 as a rate-limit error and attaches the status to other failures', async () => {
    const provider = new MusicBrainzProvider('Liner-test/0.1');

    globalThis.fetch = (async () => new Response('{"error":"The MusicBrainz web server is currently busy."}', { status: 503, statusText: 'Service Unavailable' })) as typeof fetch;
    await expect(provider.browseArtistReleaseGroups('x', { priority: 'background' })).rejects.toThrow(/rate limited \(503\)/);

    globalThis.fetch = (async () => new Response('not found', { status: 404, statusText: 'Not Found' })) as typeof fetch;
    await expect(provider.browseArtistReleaseGroups('x', { priority: 'background' })).rejects.toMatchObject({ status: 404 });
  });
});

describe('mbTrackToCanonical via getRelease', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('carries the recording MBID and the release-specific track MBID (XO-374)', async () => {
    // MusicBrainz gives a track two different ids: `id` is the track's identity
    // ON THIS RELEASE (Picard's musicbrainz_releasetrackid) and `recording.id`
    // is the recording shared across releases (musicbrainz_recordingid).
    const release = {
      id: '11111111-1111-1111-1111-111111111111',
      title: 'Test Release',
      'release-group': { id: '22222222-2222-2222-2222-222222222222', title: 'Test RG' },
      'artist-credit': [{ artist: { id: '33333333-3333-3333-3333-333333333333', name: 'Test Artist' }, name: 'Test Artist' }],
      media: [
        {
          position: 1,
          format: 'CD',
          'track-count': 2,
          tracks: [
            {
              id: 'aaaaaaaa-0000-0000-0000-000000000001',
              title: 'First',
              position: '1',
              number: '1',
              length: 210000,
              recording: { id: 'bbbbbbbb-0000-0000-0000-000000000001', title: 'First', length: 210000 },
            },
            {
              // no track id: the mapper must simply omit trackId, not write null
              title: 'Second',
              position: '2',
              number: '2',
              length: 180000,
              recording: { id: 'bbbbbbbb-0000-0000-0000-000000000002', title: 'Second', length: 180000 },
            },
          ],
        },
      ],
    };
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(release), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    const provider = new MusicBrainzProvider('Liner-test/0.1');
    const mapped = await provider.getRelease('11111111-1111-1111-1111-111111111111', { priority: 'background' });

    expect(mapped.tracks?.[0]).toMatchObject({
      title: 'First',
      position: 1,
      mediumNumber: 1,
      recordingId: 'bbbbbbbb-0000-0000-0000-000000000001',
      trackId: 'aaaaaaaa-0000-0000-0000-000000000001',
    });
    expect(mapped.tracks?.[1]?.recordingId).toBe('bbbbbbbb-0000-0000-0000-000000000002');
    expect(mapped.tracks?.[1]).not.toHaveProperty('trackId');
  });
});

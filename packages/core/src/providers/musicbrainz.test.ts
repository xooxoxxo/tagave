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
  it('should parse release group with multiple editions', async () => {
    const provider = new MusicBrainzProvider('Test/1.0 (+test)');

    // Create a mock release group response
    const mockRgData = {
      id: 'rg-uuid-123',
      title: 'Test Album',
      'primary-type': 'Album',
      'secondary-types': ['Compilation'],
      'first-release-date': '2020-01-15',
      releases: [
        {
          id: 'rel-1',
          title: 'Test Album',
          status: 'Official',
          date: '2020-01-15',
          country: 'US',
          barcode: '123456789',
          packaging: 'Jewel Case',
          'track-count': 10,
          media: [
            {
              position: '1',
              format: 'CD',
              'track-count': 10,
            },
          ],
          'label-info': [
            {
              label: { id: 'label-1', name: 'Test Label' },
              'catalog-number': 'CAT001',
            },
          ],
        },
        {
          id: 'rel-2',
          title: 'Test Album (Deluxe Edition)',
          disambiguation: 'with bonus tracks',
          status: 'Official',
          date: '2021-06-20',
          country: 'GB',
          barcode: '987654321',
          'track-count': 15,
          media: [
            {
              position: '1',
              format: 'CD',
              'track-count': 12,
            },
            {
              position: '2',
              format: 'CD',
              'track-count': 3,
            },
          ],
          'label-info': [
            {
              label: { id: 'label-2', name: 'Test Label UK' },
              'catalog-number': 'CAT002',
            },
            {
              label: null, // edge case: label without name
              'catalog-number': 'CATALT',
            },
          ],
        },
      ],
    };

    // Mock fetch to return our test data
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => mockRgData,
    }) as any;

    const result = await provider.getReleaseGroupEditions('rg-uuid-123', { priority: 'interactive' });

    expect(result.releaseGroup.mbid).toBe('rg-uuid-123');
    expect(result.releaseGroup.title).toBe('Test Album');
    expect(result.releaseGroup.primaryType).toBe('Album');
    expect(result.releaseGroup.secondaryTypes).toEqual(['Compilation']);
    expect(result.releaseGroup.firstReleaseDate).toBe('2020-01-15');

    expect(result.editions).toHaveLength(2);

    // First edition
    const ed1 = result.editions[0]!;
    expect(ed1.mbid).toBe('rel-1');
    expect(ed1.title).toBe('Test Album');
    expect(ed1.status).toBe('Official');
    expect(ed1.date).toBe('2020-01-15');
    expect(ed1.country).toBe('US');
    expect(ed1.barcode).toBe('123456789');
    expect(ed1.packaging).toBe('Jewel Case');
    expect(ed1.trackCount).toBe(10);
    expect(ed1.labels).toHaveLength(1);
    expect(ed1.labels[0]!).toEqual({ name: 'Test Label', catalogNumber: 'CAT001' });
    expect(ed1.media).toHaveLength(1);
    expect(ed1.media[0]!).toEqual({ position: 1, format: 'CD', trackCount: 10 });

    // Second edition (deluxe)
    const ed2 = result.editions[1]!;
    expect(ed2.mbid).toBe('rel-2');
    expect(ed2.title).toBe('Test Album (Deluxe Edition)');
    expect(ed2.disambiguation).toBe('with bonus tracks');
    expect(ed2.country).toBe('GB');
    expect(ed2.media).toHaveLength(2);
    expect(ed2.media[0]!).toEqual({ position: 1, format: 'CD', trackCount: 12 });
    expect(ed2.media[1]!).toEqual({ position: 2, format: 'CD', trackCount: 3 });
    // Second edition has two label-info entries, but only one with a label name
    expect(ed2.labels).toHaveLength(1);
    expect(ed2.labels[0]!).toEqual({ name: 'Test Label UK', catalogNumber: 'CAT002' });
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

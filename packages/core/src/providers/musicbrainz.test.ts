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
});

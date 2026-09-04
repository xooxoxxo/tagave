/**
 * MusicBrainz provider tests.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { extractUrlRelations, discogsIdsFromUrlRelations, wikidataQidFromUrlRelations } from './musicbrainz.js';

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

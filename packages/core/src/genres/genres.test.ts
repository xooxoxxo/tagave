/**
 * Genre canonicalisation tests.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_GENRE_MAP,
  normalizeGenreMap,
  effectiveGenres,
  type GenreMap,
  type RawTag,
} from './index.js';

describe('DEFAULT_GENRE_MAP', () => {
  it('should have a whitelist with 16 genres', () => {
    expect(DEFAULT_GENRE_MAP.whitelist).toHaveLength(16);
  });

  it('should include Metal in the whitelist', () => {
    expect(DEFAULT_GENRE_MAP.whitelist).toContain('Metal');
  });

  it('should have Rock in the whitelist', () => {
    expect(DEFAULT_GENRE_MAP.whitelist).toContain('Rock');
  });

  it('should have a comprehensive aliases record', () => {
    expect(Object.keys(DEFAULT_GENRE_MAP.aliases).length).toBeGreaterThan(0);
  });

  it('should have maxGenres set to 3', () => {
    expect(DEFAULT_GENRE_MAP.maxGenres).toBe(3);
  });

  it('should map black metal style to Metal', () => {
    expect(DEFAULT_GENRE_MAP.aliases['black metal']).toBe('Metal');
  });

  it('should map death metal style to Metal', () => {
    expect(DEFAULT_GENRE_MAP.aliases['death metal']).toBe('Metal');
  });

  it('should map hip hop/hip-hop to Hip Hop', () => {
    expect(DEFAULT_GENRE_MAP.aliases['hip hop']).toBe('Hip Hop');
    expect(DEFAULT_GENRE_MAP.aliases['hip-hop']).toBe('Hip Hop');
  });

  it('should map folk, world, & country variants to Folk, World, & Country', () => {
    expect(DEFAULT_GENRE_MAP.aliases['folk']).toBe('Folk, World, & Country');
    expect(DEFAULT_GENRE_MAP.aliases['country']).toBe('Folk, World, & Country');
  });
});

describe('normalizeGenreMap', () => {
  it('should apply defaults when input is null', () => {
    const result = normalizeGenreMap(null);
    expect(result.whitelist).toEqual(DEFAULT_GENRE_MAP.whitelist);
    expect(result.aliases).toEqual(DEFAULT_GENRE_MAP.aliases);
    expect(result.maxGenres).toBe(3);
  });

  it('should apply defaults when input is undefined', () => {
    const result = normalizeGenreMap(undefined);
    expect(result.whitelist).toEqual(DEFAULT_GENRE_MAP.whitelist);
    expect(result.maxGenres).toBe(3);
  });

  it('should deduplicate whitelist', () => {
    const input: GenreMap = {
      whitelist: ['Rock', 'Rock', 'Pop'],
      aliases: {},
      maxGenres: 3,
    };
    const result = normalizeGenreMap(input);
    expect(result.whitelist).toEqual(['Rock', 'Pop']);
  });

  it('should lower-case alias keys', () => {
    const input: GenreMap = {
      whitelist: [],
      aliases: { 'Black Metal': 'Metal', 'HIP HOP': 'Hip Hop' },
      maxGenres: 3,
    };
    const result = normalizeGenreMap(input);
    expect(result.aliases['black metal']).toBe('Metal');
    expect(result.aliases['hip hop']).toBe('Hip Hop');
    expect(result.aliases['Black Metal']).toBeUndefined();
  });

  it('should clamp maxGenres to 1', () => {
    const result = normalizeGenreMap({ maxGenres: 0 });
    expect(result.maxGenres).toBe(1);
  });

  it('should clamp maxGenres to 10', () => {
    const result = normalizeGenreMap({ maxGenres: 15 });
    expect(result.maxGenres).toBe(10);
  });

  it('should floor maxGenres if fractional', () => {
    const result = normalizeGenreMap({ maxGenres: 3.7 });
    expect(result.maxGenres).toBe(3);
  });
});

describe('effectiveGenres', () => {
  it('should map Black Metal style to Metal and Rock genre stays Rock', () => {
    const raw: RawTag[] = [
      { tag: 'Black Metal', kind: 'style', source: 'discogs', weight: 5 },
      { tag: 'Rock', kind: 'genre', source: 'discogs', weight: 10 },
    ];
    const result = effectiveGenres(raw, DEFAULT_GENRE_MAP);

    expect(result.genres).toContain('Metal');
    expect(result.genres).toContain('Rock');
  });

  it('should match whitelist case-insensitively', () => {
    const raw: RawTag[] = [
      { tag: 'rock', kind: 'genre', source: 'discogs', weight: 10 },
      { tag: 'ELECTRONIC', kind: 'genre', source: 'discogs', weight: 8 },
    ];
    const result = effectiveGenres(raw, DEFAULT_GENRE_MAP);

    expect(result.genres).toContain('Rock');
    expect(result.genres).toContain('Electronic');
  });

  it('should respect maxGenres limit with weight ordering', () => {
    const raw: RawTag[] = [
      { tag: 'Rock', kind: 'genre', source: 'discogs', weight: 10 },
      { tag: 'Electronic', kind: 'genre', source: 'discogs', weight: 8 },
      { tag: 'Pop', kind: 'genre', source: 'discogs', weight: 6 },
      { tag: 'Jazz', kind: 'genre', source: 'discogs', weight: 4 },
    ];
    const result = effectiveGenres(raw, DEFAULT_GENRE_MAP);

    expect(result.genres.length).toBeLessThanOrEqual(3);
    expect(result.genres[0]).toBe('Rock'); // highest weight
    expect(result.genres[1]).toBe('Electronic');
    expect(result.genres[2]).toBe('Pop');
  });

  it('should rank Discogs genre higher than single MB tag', () => {
    const raw: RawTag[] = [
      { tag: 'Rock', kind: 'genre', source: 'discogs', weight: 3 }, // weight = 3
      { tag: 'Electronic', kind: 'tag', source: 'musicbrainz', weight: 100 }, // weight = 0.5 + 0.5*log10(101) ≈ 1.5
    ];
    const result = effectiveGenres(raw, DEFAULT_GENRE_MAP);

    expect(result.genres[0]).toBe('Rock'); // higher weight
  });

  it('should place non-whitelisted styles in styles bucket', () => {
    const raw: RawTag[] = [
      { tag: 'Rock', kind: 'genre', source: 'discogs', weight: 10 },
      { tag: 'Psychedelic Funk', kind: 'tag', source: 'musicbrainz', weight: 5 }, // not in aliases, not in whitelist
    ];
    const result = effectiveGenres(raw, DEFAULT_GENRE_MAP);

    expect(result.genres).toContain('Rock');
    expect(result.styles).toContain('Psychedelic Funk');
  });

  it('should deduplicate styles (top 5)', () => {
    const raw: RawTag[] = [
      { tag: 'Rock', kind: 'genre', source: 'discogs', weight: 10 },
      { tag: 'Indie Rock', kind: 'tag', source: 'musicbrainz', weight: 3 },
      { tag: 'Indie Rock', kind: 'tag', source: 'musicbrainz', weight: 2 }, // duplicate, different weight
      { tag: 'Indie rock', kind: 'style', source: 'discogs', weight: 1 }, // case variation
      { tag: 'Psychedelic', kind: 'tag', source: 'musicbrainz', weight: 4 },
      { tag: 'Experimental', kind: 'tag', source: 'musicbrainz', weight: 2 },
      { tag: 'Obscure', kind: 'tag', source: 'musicbrainz', weight: 1 },
    ];
    const result = effectiveGenres(raw, DEFAULT_GENRE_MAP);

    expect(result.styles.length).toBeLessThanOrEqual(5);
    // "Indie Rock" should appear once with combined weight
    const indieRockCount = result.styles.filter((s) => s.toLowerCase() === 'indie rock').length;
    expect(indieRockCount).toBeLessThanOrEqual(1);
  });

  it('should explain rows carry mappedTo for aliased genres', () => {
    const raw: RawTag[] = [
      { tag: 'Black Metal', kind: 'style', source: 'discogs', weight: 5 },
      { tag: 'Unmatched Style', kind: 'tag', source: 'musicbrainz', weight: 3 },
    ];
    const result = effectiveGenres(raw, DEFAULT_GENRE_MAP);

    const blackMetalExplain = result.explain.find((e) => e.tag.toLowerCase() === 'black metal');
    expect(blackMetalExplain?.mappedTo).toBe('Metal');

    const unmatchedExplain = result.explain.find((e) => e.tag.toLowerCase() === 'unmatched style');
    expect(unmatchedExplain?.mappedTo).toBeNull();
  });

  it('should handle empty raw tags', () => {
    const result = effectiveGenres([], DEFAULT_GENRE_MAP);

    expect(result.genres).toEqual([]);
    expect(result.styles).toEqual([]);
    expect(result.explain).toEqual([]);
  });

  it('should handle tags with null or undefined weight', () => {
    const raw: RawTag[] = [
      { tag: 'Rock', kind: 'genre', source: 'discogs', weight: null },
      { tag: 'Pop', kind: 'genre', source: 'discogs' }, // weight undefined
    ];
    const result = effectiveGenres(raw, DEFAULT_GENRE_MAP);

    expect(result.genres.length).toBeGreaterThan(0);
  });

  it('should skip empty tag strings', () => {
    const raw: RawTag[] = [
      { tag: '', kind: 'genre', source: 'discogs', weight: 10 },
      { tag: '  ', kind: 'genre', source: 'discogs', weight: 8 },
      { tag: 'Rock', kind: 'genre', source: 'discogs', weight: 6 },
    ];
    const result = effectiveGenres(raw, DEFAULT_GENRE_MAP);

    expect(result.genres).toContain('Rock');
    expect(result.explain.length).toBe(1); // only Rock in explain
  });

  it('should respect custom maxGenres in map', () => {
    const customMap: GenreMap = {
      ...DEFAULT_GENRE_MAP,
      maxGenres: 1,
    };
    const raw: RawTag[] = [
      { tag: 'Rock', kind: 'genre', source: 'discogs', weight: 10 },
      { tag: 'Electronic', kind: 'genre', source: 'discogs', weight: 8 },
      { tag: 'Pop', kind: 'genre', source: 'discogs', weight: 6 },
    ];
    const result = effectiveGenres(raw, customMap);

    expect(result.genres).toEqual(['Rock']);
  });

  it('should resolve ties by first appearance', () => {
    const raw: RawTag[] = [
      { tag: 'Electronic', kind: 'genre', source: 'discogs', weight: 10 }, // first
      { tag: 'Rock', kind: 'genre', source: 'discogs', weight: 10 }, // second, same weight
    ];
    const customMap: GenreMap = {
      ...DEFAULT_GENRE_MAP,
      maxGenres: 1,
    };
    const result = effectiveGenres(raw, customMap);

    expect(result.genres[0]).toBe('Electronic'); // appeared first
  });

  it('should sum weights for the same genre from multiple sources', () => {
    const raw: RawTag[] = [
      { tag: 'Rock', kind: 'genre', source: 'discogs', weight: 5 },
      { tag: 'Rock', kind: 'genre', source: 'musicbrainz', weight: 100 }, // weight = 1 + log10(101) ≈ 3
    ];
    const result = effectiveGenres(raw, DEFAULT_GENRE_MAP);

    // Rock should be first because it has the highest total weight
    expect(result.genres[0]).toBe('Rock');
  });

  it('should calculate correct weights for Discogs source', () => {
    // Discogs genre weight = 3
    // Discogs style weight = 2
    const raw: RawTag[] = [
      { tag: 'Rock', kind: 'genre', source: 'discogs', weight: 0 },
      { tag: 'Punk', kind: 'style', source: 'discogs', weight: 0 },
    ];
    const result = effectiveGenres(raw, DEFAULT_GENRE_MAP);

    // Rock should rank higher (weight 3 vs 2 for Punk)
    expect(result.genres[0]).toBe('Rock');
  });

  it('should calculate correct weights for MusicBrainz source', () => {
    // MB genre weight = 1 + log10(1 + count)
    // MB tag weight = 0.5 + 0.5 * log10(1 + count)
    const raw: RawTag[] = [
      { tag: 'Rock', kind: 'genre', source: 'musicbrainz', weight: 9 }, // weight = 1 + log10(10) ≈ 2
      { tag: 'Pop', kind: 'tag', source: 'musicbrainz', weight: 99 }, // weight = 0.5 + 0.5*log10(100) = 1.5
    ];
    const result = effectiveGenres(raw, DEFAULT_GENRE_MAP);

    // Rock should rank higher
    expect(result.genres[0]).toBe('Rock');
  });
});

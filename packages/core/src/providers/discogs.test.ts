/**
 * Discogs provider tests.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  parseDiscogsDuration,
  parseDiscogsPosition,
  discogsCountryToIso,
  discogsBarcodeFromIdentifiers,
  discogsBarcodesFromSearchHit,
  mapDiscogsRelease,
  mapDiscogsSearchHit,
  parseDiscogsRef,
  conditionsFromNotes,
  DiscogsProvider,
} from './discogs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadFixture(name: string) {
  const path = join(__dirname, '__fixtures__', name);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

describe('parseDiscogsDuration', () => {
  it('should parse MM:SS format', () => {
    expect(parseDiscogsDuration('3:32')).toBe(212000);
    expect(parseDiscogsDuration('0:05')).toBe(5000);
  });

  it('should parse H:MM:SS format', () => {
    expect(parseDiscogsDuration('1:02:30')).toBe(3750000);
  });

  it('should handle empty duration', () => {
    expect(parseDiscogsDuration('')).toBe(0);
    expect(parseDiscogsDuration(undefined)).toBe(0);
  });
});

describe('parseDiscogsPosition', () => {
  const cases: Array<[string, { medium: number; position: number }]> = [
    // Bare numbers
    ['7', { medium: 1, position: 7 }],
    ['1', { medium: 1, position: 1 }],

    // With dashes: "1-3" → medium 1 pos 3; "2-03" → medium 2 pos 3
    ['1-3', { medium: 1, position: 3 }],
    ['2-03', { medium: 2, position: 3 }],
    ['CD1-3', { medium: 1, position: 3 }],

    // Side letters: A,B → medium 1; C,D → medium 2; E,F → medium 3
    ['A1', { medium: 1, position: 1 }],
    ['B2', { medium: 1, position: 2 }],
    ['C1', { medium: 2, position: 1 }],
    ['D', { medium: 2, position: 0 }],

    // Double-A side
    ['AA1', { medium: 1, position: 1 }],
    ['AA2', { medium: 1, position: 2 }],
  ];

  for (const [input, expected] of cases) {
    it(`should parse "${input}" as medium ${expected.medium} position ${expected.position}`, () => {
      expect(parseDiscogsPosition(input)).toEqual(expected);
    });
  }
});

describe('discogsCountryToIso', () => {
  it('should handle direct codes', () => {
    expect(discogsCountryToIso('DE')).toBe('DE');
    expect(discogsCountryToIso('FR')).toBe('FR');
  });

  it('should map UK to GB', () => {
    expect(discogsCountryToIso('UK')).toBe('GB');
  });

  it('should map USA variations to US', () => {
    expect(discogsCountryToIso('USA')).toBe('US');
    expect(discogsCountryToIso('US')).toBe('US');
  });

  it('should map Europe regions', () => {
    expect(discogsCountryToIso('Europe')).toBe('XE');
    expect(discogsCountryToIso('UK & Europe')).toBe('XE');
    expect(discogsCountryToIso('Scandinavia')).toBe('XE');
  });

  it('should map full country names', () => {
    expect(discogsCountryToIso('Sweden')).toBe('SE');
    expect(discogsCountryToIso('Germany')).toBe('DE');
    expect(discogsCountryToIso('Japan')).toBe('JP');
  });

  it('should return null for unknown', () => {
    expect(discogsCountryToIso('Unknown')).toBeNull();
    expect(discogsCountryToIso('')).toBeNull();
  });
});

describe('discogsBarcodeFromIdentifiers', () => {
  it('should extract Barcode type identifier', () => {
    const identifiers = [
      { type: 'Barcode', value: '5012394144777' },
      { type: 'Label Code', value: 'LC 0316' },
    ];
    expect(discogsBarcodeFromIdentifiers(identifiers)).toBe('5012394144777');
  });

  it('should strip non-digits', () => {
    const identifiers = [
      { type: 'Barcode', value: 'UPC 5012394144777' },
    ];
    expect(discogsBarcodeFromIdentifiers(identifiers)).toBe('5012394144777');
  });

  it('should return undefined if no Barcode found', () => {
    const identifiers = [
      { type: 'Label Code', value: 'LC 0316' },
    ];
    expect(discogsBarcodeFromIdentifiers(identifiers)).toBeUndefined();
  });
});

describe('discogsBarcodesFromSearchHit', () => {
  it('should filter barcodes to ≥8 digits', () => {
    const barcodes = ['1234567', '5012394144777', 'LC 0316'];
    const result = discogsBarcodesFromSearchHit(barcodes);
    expect(result).toEqual(['5012394144777']);
  });

  it('should return empty array if none match', () => {
    const barcodes = ['123', 'ABC'];
    expect(discogsBarcodesFromSearchHit(barcodes)).toEqual([]);
  });
});

describe('parseDiscogsRef', () => {
  const cases: Array<[string, { kind: 'release' | 'master'; id: number } | null]> = [
    // Bracket notation
    ['[r123]', { kind: 'release', id: 123 }],
    ['[m456]', { kind: 'master', id: 456 }],

    // Prefix notation
    ['r123', { kind: 'release', id: 123 }],
    ['m456', { kind: 'master', id: 456 }],

    // URLs with locale prefix
    ['https://www.discogs.com/release/249504-Rick-Astley-Never-Gonna-Give-You-Up', { kind: 'release', id: 249504 }],
    ['https://www.discogs.com/de/release/249504', { kind: 'release', id: 249504 }],
    ['https://www.discogs.com/master/96559', { kind: 'master', id: 96559 }],

    // Bare digits
    ['249504', { kind: 'release', id: 249504 }],

    // Garbage
    ['not-a-ref', null],
  ];

  for (const [input, expected] of cases) {
    it(`should parse "${input}"`, () => {
      expect(parseDiscogsRef(input)).toEqual(expected);
    });
  }
});

describe('mapDiscogsRelease', () => {
  it('should map a realistic 7" single with A/B sides', () => {
    const fixture = loadFixture('discogs_release_249504.json');
    const canonical = mapDiscogsRelease(fixture);

    expect(canonical.id).toBe('249504');
    expect(canonical.title).toBe('Never Gonna Give You Up');
    expect(canonical.artists).toContain('Rick Astley');
    expect(canonical.year).toBe(1987);
    expect(canonical.country).toBe('GB');
    expect(canonical.barcode).toBe('5012394144777');
    expect(canonical.discogsMasterId).toBe('96559');

    // Check tracklist: A and B sides should be medium 1 positions 1 and 2
    expect(canonical.tracks.length).toBe(2);
    expect(canonical.tracks[0]!.position).toBe(1);
    expect(canonical.tracks[1]!.position).toBe(2);
    expect(canonical.tracks[0]!.mediumNumber).toBe(1);

  });
});

describe('mapDiscogsSearchHit', () => {
  it('should map a search hit', () => {
    const hit = {
      id: 249504,
      title: 'Rick Astley - Never Gonna Give You Up',
      resource_url: 'https://api.discogs.com/releases/249504',
      year: 1987,
      country: 'UK',
      format: ['7"', '45 RPM', 'Single'],
      label: ['RCA'],
      catno: 'PB 41447',
      barcode: ['5012394144777'],
      genre: ['Electronic', 'Pop'],
    };
    const canonical = mapDiscogsSearchHit(hit);

    expect(canonical.id).toBe('249504');
    expect(canonical.title).toBe('Never Gonna Give You Up');
    expect(canonical.artists).toContain('Rick Astley');
    expect(canonical.tracks).toEqual([]);
    expect(canonical.media).toBe('7"');
    expect(canonical.genres).toContain('Pop');
  });
});

describe('DiscogsProvider', () => {
  it('should authenticate when token provided', () => {
    const provider = new DiscogsProvider({
      token: 'mytoken',
      userAgent: 'test',
    });
    expect(provider.authenticated).toBe(true);
  });

  it('should not authenticate when no token', () => {
    const provider = new DiscogsProvider({
      userAgent: 'test',
    });
    expect(provider.authenticated).toBe(false);
  });

  it('should capture rate limit headers', async () => {
    const mockFetch = async (url: string, options: any) => {
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: {
          'X-Discogs-Ratelimit': '55',
          'X-Discogs-Ratelimit-Used': '10',
          'X-Discogs-Ratelimit-Remaining': '45',
        },
      });
    };

    const provider = new DiscogsProvider({
      userAgent: 'test',
      fetchImpl: mockFetch as any,
    });

    await provider.searchReleases({ albumTitle: 'test' }, { priority: 'background' });

    expect(provider.lastRateLimit).toEqual({
      limit: 55,
      used: 10,
      remaining: 45,
    });
  });

  it('should throw 429 with retryAfterMs property', async () => {
    const mockFetch = async (url: string, options: any) => {
      return new Response(JSON.stringify({ error: 'rate limited' }), {
        status: 429,
        headers: {
          'Retry-After': '30',
        },
      });
    };

    const provider = new DiscogsProvider({
      userAgent: 'test',
      fetchImpl: mockFetch as any,
    });

    try {
      await provider.searchReleases({ albumTitle: 'test' }, { priority: 'background' });
      expect.fail('Should have thrown');
    } catch (err: any) {
      expect(err.message).toContain('rate limited (429)');
      expect(err.retryAfterMs).toBe(30000);
    }
  });
});

describe('search hit year as string (live payload shape)', () => {
  it('coerces "1987" to 1987 and drops junk', async () => {
    const fx = JSON.parse(readFileSync(new URL('./__fixtures__/discogs_search_noauth.json', import.meta.url), 'utf8'));
    fx.results[0].year = '1987';
    fx.results[1].year = 'n/a';
    const fetchImpl = (async () => new Response(JSON.stringify(fx), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const p = new DiscogsProvider({ userAgent: 'test', fetchImpl });
    const hits = await p.searchReleases({ albumTitle: 'Whenever You Need Somebody', artistName: 'Rick Astley' }, { priority: 'background' });
    expect(hits[0]!.release.year).toBe(1987);
    expect(hits[1]!.release.year).toBeUndefined();
  });
});

describe('conditionsFromNotes', () => {
  it('extracts media condition', () => {
    const fields = [{ id: 1, name: 'Media Condition' }];
    const notes = [{ fieldId: 1, value: 'Very Good Plus' }];
    const result = conditionsFromNotes(notes, fields);
    expect(result.mediaCondition).toBe('Very Good Plus');
    expect(result.sleeveCondition).toBeUndefined();
  });

  it('extracts sleeve condition case-insensitively', () => {
    const fields = [{ id: 2, name: 'SLEEVE CONDITION' }];
    const notes = [{ fieldId: 2, value: 'Mint' }];
    const result = conditionsFromNotes(notes, fields);
    expect(result.sleeveCondition).toBe('Mint');
    expect(result.mediaCondition).toBeUndefined();
  });

  it('extracts notes field', () => {
    const fields = [{ id: 3, name: 'Notes' }];
    const notes = [{ fieldId: 3, value: 'Some notes about the item' }];
    const result = conditionsFromNotes(notes, fields);
    expect(result.notes).toBe('Some notes about the item');
  });

  it('handles mixed conditions', () => {
    const fields = [
      { id: 1, name: 'Media Condition' },
      { id: 2, name: 'Sleeve Condition' },
      { id: 3, name: 'Notes' },
    ];
    const notes = [
      { fieldId: 1, value: 'Good' },
      { fieldId: 2, value: 'Fair' },
      { fieldId: 3, value: 'Slight crease' },
    ];
    const result = conditionsFromNotes(notes, fields);
    expect(result).toEqual({
      mediaCondition: 'Good',
      sleeveCondition: 'Fair',
      notes: 'Slight crease',
    });
  });

  it('ignores unknown field IDs', () => {
    const fields = [{ id: 1, name: 'Media Condition' }];
    const notes = [
      { fieldId: 1, value: 'Good' },
      { fieldId: 999, value: 'Unknown' },
    ];
    const result = conditionsFromNotes(notes, fields);
    expect(result.mediaCondition).toBe('Good');
  });

  it('handles values from unknown field names', () => {
    const fields = [{ id: 1, name: 'Custom Field' }];
    const notes = [{ fieldId: 1, value: 'Some value' }];
    const result = conditionsFromNotes(notes, fields);
    expect(result.mediaCondition).toBeUndefined();
    expect(result.sleeveCondition).toBeUndefined();
    expect(result.notes).toBeUndefined();
  });

  it('handles empty notes array', () => {
    const fields = [{ id: 1, name: 'Media Condition' }];
    const result = conditionsFromNotes([], fields);
    expect(result).toEqual({});
  });
});

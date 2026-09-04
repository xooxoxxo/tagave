/**
 * Tests for pure helper functions in enrichRelease.ts.
 */
import { describe, it, expect } from 'vitest';
import { normalizeCatno, pickBarcodeHit, pickCatnoHit, pickFuzzyHit } from './enrichRelease.js';
import type { CanonicalRelease } from '@liner/core';

describe('normalizeCatno', () => {
  it('converts to uppercase', () => {
    expect(normalizeCatno('abc123')).toBe('ABC123');
    expect(normalizeCatno('AbC123')).toBe('ABC123');
  });

  it('strips spaces and dashes', () => {
    expect(normalizeCatno('ABC-123')).toBe('ABC123');
    expect(normalizeCatno('ABC 123')).toBe('ABC123');
    expect(normalizeCatno('ABC - 123')).toBe('ABC123');
    expect(normalizeCatno('A BC - 1 23')).toBe('ABC123');
  });

  it('handles empty string', () => {
    expect(normalizeCatno('')).toBe('');
  });
});

describe('pickBarcodeHit', () => {
  const minimalRelease = (barcode?: string): CanonicalRelease => ({
    id: '123',
    releaseGroupId: 'rg1',
    title: 'Test',
    artists: [],
    tracks: [],
    source: 'discogs',
    ...(barcode ? { barcode } : {}),
  });

  it('finds exact barcode match digit-for-digit', () => {
    const hits = [minimalRelease('123-456-789'), minimalRelease('987-654-321')];
    const hit = pickBarcodeHit(hits, '123456789');
    expect(hit?.barcode).toBe('123-456-789');
  });

  it('ignores non-digit characters in both barcode and hit', () => {
    const hits = [minimalRelease('LC-00123-45')];
    const hit = pickBarcodeHit(hits, 'LC 0012345');
    expect(hit?.barcode).toBe('LC-00123-45');
  });

  it('returns undefined when no match found', () => {
    const hits = [minimalRelease('123-456-789')];
    const hit = pickBarcodeHit(hits, '987654321');
    expect(hit).toBeUndefined();
  });

  it('returns undefined when barcode is empty', () => {
    const hits = [minimalRelease('123456789')];
    const hit = pickBarcodeHit(hits, '');
    expect(hit).toBeUndefined();
  });

  it('handles hits with missing barcode', () => {
    const hits = [minimalRelease(), minimalRelease('123-456-789')];
    const hit = pickBarcodeHit(hits, '123456789');
    expect(hit?.barcode).toBe('123-456-789');
  });

  it('handles noise in barcode (matrix/runout strings)', () => {
    const hits = [minimalRelease('5099923456789')];
    const hit = pickBarcodeHit(hits, '5099923456789');
    expect(hit?.barcode).toBe('5099923456789');
  });
});

describe('pickCatnoHit', () => {
  const minimalRelease = (
    title: string,
    artists: string[],
    catalogNumber?: string,
    year?: number
  ): CanonicalRelease => ({
    id: '123',
    releaseGroupId: 'rg1',
    title,
    artists,
    tracks: [],
    source: 'discogs',
    ...(catalogNumber ? { catalogNumber } : {}),
    ...(year !== undefined ? { year } : {}),
  });

  it('finds exact catno match case-insensitively', () => {
    const hits = [
      minimalRelease('Release A', ['Artist 1'], 'ABC-123', 2000),
      minimalRelease('Release B', ['Artist 2'], 'XYZ-789', 2001),
    ];
    const mbMeta = { title: 'Release A', artists: ['Artist 1'], year: 2000 };
    const hit = pickCatnoHit(hits, 'abc-123', mbMeta);
    expect(hit?.catalogNumber).toBe('ABC-123');
  });

  it('strips spaces and dashes when comparing', () => {
    const hits = [minimalRelease('Release', ['Artist'], 'ABC-123', 2000)];
    const mbMeta = { title: 'Release', artists: ['Artist'], year: 2000 };
    const hit = pickCatnoHit(hits, 'ABC 123', mbMeta);
    expect(hit?.catalogNumber).toBe('ABC-123');
  });

  it('requires fuzzy score >= 0.7', () => {
    const hits = [
      minimalRelease('Completely Different Album', ['Totally Different Artist'], 'ABC-123', 1990),
    ];
    const mbMeta = { title: 'My Album', artists: ['My Artist'], year: 2000 };
    const hit = pickCatnoHit(hits, 'ABC-123', mbMeta);
    expect(hit).toBeUndefined();
  });

  it('returns undefined when catno is empty', () => {
    const hits = [minimalRelease('Release', ['Artist'], 'ABC-123', 2000)];
    const mbMeta = { title: 'Release', artists: ['Artist'], year: 2000 };
    const hit = pickCatnoHit(hits, '', mbMeta);
    expect(hit).toBeUndefined();
  });

  it('returns undefined when no hits with matching catno', () => {
    const hits = [minimalRelease('Release', ['Artist'], 'ABC-123', 2000)];
    const mbMeta = { title: 'Release', artists: ['Artist'], year: 2000 };
    const hit = pickCatnoHit(hits, 'XYZ-789', mbMeta);
    expect(hit).toBeUndefined();
  });

  it('handles hits with missing catalogNumber', () => {
    const hits = [
      minimalRelease('Release', ['Artist'], undefined, 2000),
      minimalRelease('Release', ['Artist'], 'ABC-123', 2000),
    ];
    const mbMeta = { title: 'Release', artists: ['Artist'], year: 2000 };
    const hit = pickCatnoHit(hits, 'ABC-123', mbMeta);
    expect(hit?.catalogNumber).toBe('ABC-123');
  });
});

describe('pickFuzzyHit', () => {
  const minimalRelease = (
    title: string,
    artists: string[],
    year?: number,
    discogsMasterId?: string
  ): CanonicalRelease => ({
    id: '123',
    releaseGroupId: 'rg1',
    title,
    artists,
    tracks: [],
    source: 'discogs',
    ...(year !== undefined ? { year } : {}),
    ...(discogsMasterId ? { discogsMasterId } : {}),
  });

  it('finds best hit >= FUZZY_BRIDGE_ACCEPT (0.85)', () => {
    const hits = [
      minimalRelease('My Album', ['My Artist'], 2000),
      minimalRelease('My Album', ['My Artist'], 2000),
    ];
    const mbMeta: { title: string; artists: string[]; year?: number } = {
      title: 'My Album',
      artists: ['My Artist'],
      year: 2000,
    };
    const result = pickFuzzyHit(hits, mbMeta);
    expect(result).toBeDefined();
    expect(result!.score).toBeGreaterThanOrEqual(0.85);
  });

  it('returns undefined when best score < 0.85', () => {
    const hits = [minimalRelease('Completely Different', ['Totally Different'], 1990)];
    const mbMeta: { title: string; artists: string[]; year?: number } = {
      title: 'My Album',
      artists: ['My Artist'],
      year: 2000,
    };
    const result = pickFuzzyHit(hits, mbMeta);
    expect(result).toBeUndefined();
  });

  it('prefers hits matching preferredMasterId', () => {
    const hits = [
      minimalRelease('My Album', ['My Artist'], 2000, '123'),
      minimalRelease('My Album', ['My Artist'], 2000, '456'),
    ];
    const mbMeta: { title: string; artists: string[]; year?: number } = {
      title: 'My Album',
      artists: ['My Artist'],
      year: 2000,
    };
    const result = pickFuzzyHit(hits, mbMeta, 456);
    expect(result).toBeDefined();
    expect(result!.hit.discogsMasterId).toBe('456');
  });

  it('falls back to highest score when no preferred master match', () => {
    const hits = [
      minimalRelease('My Album', ['My Artist'], 2000, '123'),
      minimalRelease('My Album', ['My Artist'], 1999, '456'),
    ];
    const mbMeta: { title: string; artists: string[]; year?: number } = {
      title: 'My Album',
      artists: ['My Artist'],
      year: 2000,
    };
    const result = pickFuzzyHit(hits, mbMeta, 999);
    expect(result).toBeDefined();
    // First hit is identical (year 2000), should score higher
    expect(result!.hit.discogsMasterId).toBe('123');
  });

  it('handles empty hits array', () => {
    const hits: CanonicalRelease[] = [];
    const mbMeta: { title: string; artists: string[]; year?: number } = {
      title: 'My Album',
      artists: ['My Artist'],
      year: 2000,
    };
    const result = pickFuzzyHit(hits, mbMeta);
    expect(result).toBeUndefined();
  });

  it('handles hits with missing discogsMasterId', () => {
    const hits = [
      minimalRelease('My Album', ['My Artist'], 2000),
      minimalRelease('My Album', ['My Artist'], 2000),
    ];
    const mbMeta: { title: string; artists: string[]; year?: number } = {
      title: 'My Album',
      artists: ['My Artist'],
      year: 2000,
    };
    const result = pickFuzzyHit(hits, mbMeta);
    expect(result).toBeDefined();
  });

  it('compares masterIds as strings', () => {
    const hits = [minimalRelease('My Album', ['My Artist'], 2000, '456')];
    const mbMeta: { title: string; artists: string[]; year?: number } = {
      title: 'My Album',
      artists: ['My Artist'],
      year: 2000,
    };
    const result = pickFuzzyHit(hits, mbMeta, '456');
    expect(result).toBeDefined();
    expect(result!.hit.discogsMasterId).toBe('456');
  });
});

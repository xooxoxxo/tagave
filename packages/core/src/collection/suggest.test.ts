import { describe, it, expect } from 'vitest';
import { rankPhysicalSuggestions, scoreSuggestion, discogsArtistName, matchTitle } from './suggest.js';
import { physicalFormatLabel } from './format.js';

const album = (id: string, title: string, artist: string, year: number | null = null, trackCount: number | null = null) =>
  ({ id, title, artist, year, trackCount });

describe('physical record suggestions', () => {
  const baroness = { title: 'Yellow & Green', artists: ['Baroness'], year: 2012, trackCount: 18 };
  const library = [
    album('purple', 'Purple', 'Baroness', 2015, 10),
    album('yg', 'Yellow & Green', 'Baroness', 2012, 18),
    album('blue', 'Blue Record', 'Baroness', 2009, 12),
    album('other', 'Yellow', 'Coldplay', 2000, 1),
  ];

  it('puts the album with the same title, artist and year first', () => {
    const ranked = rankPhysicalSuggestions(baroness, library);
    expect(ranked[0]?.album.id).toBe('yg');
    expect(ranked[0]!.score).toBeGreaterThan(0.9);
  });

  it('leaves out other albums by the same artist', () => {
    const ids = rankPhysicalSuggestions(baroness, library).map((s) => s.album.id);
    expect(ids).not.toContain('purple');
    expect(ids).not.toContain('blue');
  });

  it('forgives Discogs name suffixes, edition noise and "&" vs "and"', () => {
    const rec = { title: 'Yellow and Green (Deluxe Edition)', artists: ['Baroness (2)'], year: 2012 };
    const ranked = rankPhysicalSuggestions(rec, library);
    expect(ranked[0]?.album.id).toBe('yg');
  });

  it('prefers the matching year between two pressings of the same title', () => {
    const twins = [album('a', 'Blue Record', 'Baroness', 2019), album('b', 'Blue Record', 'Baroness', 2009)];
    const ranked = rankPhysicalSuggestions({ title: 'Blue Record', artists: ['Baroness'], year: 2009 }, twins);
    expect(ranked.map((s) => s.album.id)).toEqual(['b', 'a']);
  });

  it('suggests nothing when no album is close', () => {
    expect(rankPhysicalSuggestions({ title: 'Kind of Blue', artists: ['Miles Davis'] }, library)).toEqual([]);
  });

  it('caps the list', () => {
    const many = Array.from({ length: 6 }, (_, i) => album(`x${i}`, 'Yellow & Green', 'Baroness', 2012));
    expect(rankPhysicalSuggestions(baroness, many, { limit: 3 })).toHaveLength(3);
  });

  it('scores 0..1', () => {
    for (const a of library) {
      const s = scoreSuggestion(baroness, a);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it('offers each disc of a double album filed as its own folder', () => {
    const split = [album('y', 'Yellow [DISC 1]', 'Baroness'), album('g', 'Green [DISC 2]', 'Baroness'), album('p', 'Purple', 'Baroness')];
    const ids = rankPhysicalSuggestions(baroness, split).map((s) => s.album.id);
    expect(ids.sort()).toEqual(['g', 'y']);
  });

  it('cleans Discogs names and edition noise', () => {
    expect(discogsArtistName('Baroness (2)')).toBe('Baroness');
    expect(discogsArtistName('Prince*')).toBe('Prince');
    expect(matchTitle('Purple (2015 Remastered)')).toBe('Purple');
    expect(matchTitle('Yellow [DISC 1]')).toBe('Yellow');
    expect(matchTitle('Green - CD2')).toBe('Green');
  });
});

describe('physical format line', () => {
  it('reads Discogs collection formats with quantities', () => {
    expect(physicalFormatLabel([{ name: 'Vinyl', qty: '2' }, { name: 'CD', qty: '1' }])).toBe('2×Vinyl, CD');
  });
  it('reads a release media list', () => {
    expect(physicalFormatLabel([{ position: 1, format: 'CD', trackCount: 9 }, { position: 2, format: 'CD', trackCount: 9 }])).toBe('2×CD');
  });
  it('answers null for nothing useful', () => {
    expect(physicalFormatLabel(null)).toBeNull();
    expect(physicalFormatLabel([])).toBeNull();
  });
});

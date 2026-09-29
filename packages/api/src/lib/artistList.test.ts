import { describe, it, expect } from 'vitest';
import {
  artistGroup, artistInitials, artistLabel, cleanArtistName, compareArtistNames, isSymbolOnlyName, UNKNOWN_ARTIST,
} from '@liner/shared';
import { orderArtists, parseArtistGroup, parseArtistSort, type ArtistRow } from './artistList.js';

describe('artist name display', () => {
  it('strips C1 control bytes left by a bad encoding', () => {
    expect(cleanArtistName('\u008F\u008E¬}')).toBe('¬}');
  });

  it('strips zero-width and format characters and collapses spaces', () => {
    expect(cleanArtistName('​Massive  Attack﻿ ')).toBe('Massive Attack');
  });

  it('shows a blank or invisible name as "Unknown artist"', () => {
    expect(artistLabel('')).toBe(UNKNOWN_ARTIST);
    expect(artistLabel('   ')).toBe(UNKNOWN_ARTIST);
    expect(artistLabel('​\u0000\u0007')).toBe(UNKNOWN_ARTIST);
    expect(artistLabel(null)).toBe(UNKNOWN_ARTIST);
  });

  it('drops block glyphs that render as a solid box', () => {
    expect(artistLabel('██████')).toBe(UNKNOWN_ARTIST);
    expect(artistLabel('�')).toBe(UNKNOWN_ARTIST);
  });

  it('keeps punctuation-only and symbol names visible as they are', () => {
    expect(artistLabel('+/-')).toBe('+/-');
    expect(artistLabel('!!!')).toBe('!!!');
    expect(artistLabel('◯')).toBe('◯');
  });

  it('keeps names in other scripts intact', () => {
    expect(artistLabel('이지수')).toBe('이지수');
    expect(artistLabel('Сплин')).toBe('Сплин');
  });

  it('knows a symbol-only name', () => {
    expect(isSymbolOnlyName('+/-')).toBe(true);
    expect(isSymbolOnlyName('†††')).toBe(true);
    expect(isSymbolOnlyName('')).toBe(true);
    expect(isSymbolOnlyName('!!! (Chk Chk Chk)')).toBe(false);
    expect(isSymbolOnlyName('이지수')).toBe(false);
  });

  it('builds initials without emoji', () => {
    expect(artistInitials('Massive Attack')).toBe('MA');
    expect(artistInitials('The Cure')).toBe('C');
    expect(artistInitials('björk')).toBe('B');
    expect(artistInitials('이지수')).toBe('이');
    expect(artistInitials('+/-')).toBe('#');
    expect(artistInitials('')).toBe('?');
  });
});

describe('artist groups', () => {
  it('files Latin names by base letter, ignoring accents and a leading "The"', () => {
    expect(artistGroup('Émilie Simon')).toBe('E');
    expect(artistGroup('Øresund Space Collective')).toBe('O');
    expect(artistGroup('The Beatles')).toBe('B');
    expect(artistGroup('The Beatles', 'Beatles, The')).toBe('B');
    expect(artistGroup('(hed) p.e.')).toBe('H');
  });

  it('files digits, other scripts and junk separately', () => {
    expect(artistGroup('2Pac')).toBe('0-9');
    expect(artistGroup('이지수')).toBe('other');
    expect(artistGroup('Сплин')).toBe('other');
    expect(artistGroup('+/-')).toBe('#');
    expect(artistGroup('\u008F\u008E¬}')).toBe('#');
    expect(artistGroup('')).toBe('#');
    expect(artistGroup('The')).toBe('T');
  });
});

describe('artist name order', () => {
  const names = ['+/-', 'zeta', '이지수', '\u008F\u008E¬}', 'The Beatles', 'Air', '', '10cc', 'Émilie Simon', '2Pac', 'Сплин', 'Björk', '◯'];

  it('puts A–Z, then digits, then other scripts, then symbols and blanks', () => {
    const sorted = [...names].sort((a, b) => compareArtistNames({ name: a }, { name: b }));
    expect(sorted.slice(0, 7)).toEqual(['Air', 'The Beatles', 'Björk', 'Émilie Simon', 'zeta', '2Pac', '10cc']);
    expect(sorted.slice(7, 9).sort()).toEqual(['Сплин', '이지수'].sort());
    expect(sorted.slice(9, 12).sort()).toEqual(['+/-', '\u008F\u008E¬}', '◯'].sort());
    expect(sorted[12]).toBe('');
  });

  it('prefers the MusicBrainz sort name', () => {
    const sorted = [{ name: 'The The', sortName: 'The, The' }, { name: 'Air' }, { name: 'Tears for Fears' }]
      .sort(compareArtistNames).map((a) => a.name);
    expect(sorted).toEqual(['Air', 'Tears for Fears', 'The The']);
  });
});

const row = (name: string, patch: Partial<ArtistRow> = {}): ArtistRow => ({
  id: null, name, sortName: null, resolved: false, albumCount: 1, trackCount: 10,
  yearFrom: null, yearTo: null, addedAt: null, ...patch,
});

describe('orderArtists', () => {
  const rows = [
    row('+/-', { albumCount: 9, addedAt: '2026-09-01T00:00:00Z' }),
    row('Beirut', { albumCount: 3, addedAt: '2026-01-01T00:00:00Z' }),
    row('Air', { albumCount: 3, addedAt: '2026-05-01T00:00:00Z' }),
    row('Bonobo', { albumCount: 7 }),
    row('이지수', { albumCount: 2, addedAt: '2026-09-20T00:00:00Z' }),
  ];

  it('orders by name with junk last, and counts groups in list order', () => {
    const out = orderArtists(rows, { sort: 'name' });
    expect(out.items.map((r) => r.name)).toEqual(['Air', 'Beirut', 'Bonobo', '이지수', '+/-']);
    expect(out.groups).toEqual([
      { key: 'A', count: 1 }, { key: 'B', count: 2 }, { key: 'other', count: 1 }, { key: '#', count: 1 },
    ]);
  });

  it('orders by album count, ties by name', () => {
    expect(orderArtists(rows, { sort: 'albums' }).items.map((r) => r.name))
      .toEqual(['+/-', 'Bonobo', 'Air', 'Beirut', '이지수']);
  });

  it('orders by most recently added, undated last', () => {
    expect(orderArtists(rows, { sort: 'recent' }).items.map((r) => r.name))
      .toEqual(['이지수', '+/-', 'Air', 'Beirut', 'Bonobo']);
  });

  it('keeps one group but still counts them all', () => {
    const out = orderArtists(rows, { sort: 'name', group: 'B' });
    expect(out.items.map((r) => r.name)).toEqual(['Beirut', 'Bonobo']);
    expect(out.groups).toHaveLength(4);
  });

  it('parses unknown sort and group values safely', () => {
    expect(parseArtistSort('albums')).toBe('albums');
    expect(parseArtistSort('drop table')).toBe('name');
    expect(parseArtistGroup('B')).toBe('B');
    expect(parseArtistGroup('#')).toBe('#');
    expect(parseArtistGroup('b')).toBeNull();
    expect(parseArtistGroup(undefined)).toBeNull();
  });
});

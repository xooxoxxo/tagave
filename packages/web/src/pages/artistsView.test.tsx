/**
 * The artists browser's small pieces: the quiet meta line, the remembered
 * Grid/List choice, and the picture (cover mosaic or initials, never an emoji
 * or an empty box).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArtistArtwork, IdentityMark, toneOf } from '../components/ArtistArtwork';
import { artistMeta, mosaicCovers, readArtistsView, writeArtistsView, yearsLabel } from './artistsView';

describe('artist meta line', () => {
  it('reads "12 albums · 1994–2012"', () => {
    expect(artistMeta({ albumCount: 12, yearFrom: 1994, yearTo: 2012 })).toBe('12 albums · 1994–2012');
  });

  it('uses the singular and a single year', () => {
    expect(artistMeta({ albumCount: 1, yearFrom: 2003, yearTo: 2003 })).toBe('1 album · 2003');
  });

  it('drops the years when no album has one', () => {
    expect(artistMeta({ albumCount: 3, yearFrom: null, yearTo: null })).toBe('3 albums');
    expect(yearsLabel(null, 2001)).toBe('2001');
  });
});

describe('remembered view', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });

  it('defaults to grid and remembers list', () => {
    expect(readArtistsView()).toBe('grid');
    writeArtistsView('list');
    expect(readArtistsView()).toBe('list');
    writeArtistsView('grid');
    expect(readArtistsView()).toBe('grid');
  });

  it('survives storage that throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    });
    expect(readArtistsView()).toBe('grid');
    expect(() => writeArtistsView('list')).not.toThrow();
  });
});

describe('artist picture', () => {
  it('tiles up to four covers', () => {
    expect(mosaicCovers(['a', 'b', 'c', 'd', 'e'])).toEqual(['a', 'b', 'c', 'd']);
    const html = renderToStaticMarkup(<ArtistArtwork name="Air" coverAlbumIds={['a', 'b', 'c']} />);
    expect(html).toContain('data-count="3"');
    expect(html.match(/<img /g)).toHaveLength(3);
    expect(html).toContain('/api/v1/images/album/a');
  });

  it('shows one cover in a list thumbnail', () => {
    const html = renderToStaticMarkup(<ArtistArtwork name="Air" coverAlbumIds={['a', 'b']} compact />);
    expect(html.match(/<img /g)).toHaveLength(1);
  });

  it('falls back to initials, "#" for symbols and "?" for a blank name', () => {
    expect(renderToStaticMarkup(<ArtistArtwork name="Massive Attack" />)).toContain('>MA<');
    expect(renderToStaticMarkup(<ArtistArtwork name="+/-" />)).toContain('>#<');
    expect(renderToStaticMarkup(<ArtistArtwork name={'​'} />)).toContain('>?<');
    expect(renderToStaticMarkup(<ArtistArtwork name="이지수" />)).toContain('>이<');
  });

  it('gives a name a stable tone', () => {
    expect(toneOf('Air')).toBe(toneOf('Air'));
    expect([0, 1, 2]).toContain(toneOf('Beirut'));
  });

  it('marks identity with a label, not a sentence', () => {
    const linked = renderToStaticMarkup(<IdentityMark resolved />);
    expect(linked).toContain('Identified artist');
    expect(linked).toContain('title="Identified artist: opens the profile and discography"');
    expect(renderToStaticMarkup(<IdentityMark resolved={false} />)).toContain('From tags only');
  });
});

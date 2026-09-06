/**
 * Link-out resolver tests (spec REV-2): Wikidata identifiers → direct links,
 * MusicBrainz review relationships → direct links, search templates for the
 * rest. Only URLs — nothing is ever fetched from these publications.
 */
import { describe, it, expect } from 'vitest';
import { SEARCH_TEMPLATES, resolveReviewLinks, sourceFromUrl } from './links.js';

const base = { title: 'OK Computer', artist: 'Radiohead' };

describe('sourceFromUrl', () => {
  it('maps publication hosts to source slugs', () => {
    expect(sourceFromUrl('https://pitchfork.com/reviews/albums/6656-ok-computer/')).toBe('pitchfork');
    expect(sourceFromUrl('https://www.allmusic.com/album/mw0000024289')).toBe('allmusic');
    expect(sourceFromUrl('http://www.bbc.co.uk/music/reviews/wcp2')).toBe('bbc');
    expect(sourceFromUrl('https://ra.co/reviews/1')).toBe('residentadvisor');
    expect(sourceFromUrl('https://www.theguardian.com/music/x')).toBe('guardian');
    expect(sourceFromUrl('https://music.avclub.com/review')).toBe('avclub');
    expect(sourceFromUrl('https://www.some-zine.co.uk/review')).toBe('somezine');
    expect(sourceFromUrl('not a url')).toBeNull();
  });
});

describe('resolveReviewLinks', () => {
  it('turns Wikidata identifiers into direct links and suppresses their search templates', () => {
    const links = resolveReviewLinks({
      ...base,
      identity: { allmusicId: 'mw0000024289', rymId: 'album/radiohead/ok-computer', metacriticId: 'music/ok-computer/radiohead', enwikiTitle: 'OK_Computer' },
    });
    const direct = links.filter((l) => l.discoveredVia === 'wikidata');
    expect(direct).toEqual(expect.arrayContaining([
      { source: 'allmusic', url: 'https://www.allmusic.com/album/mw0000024289', discoveredVia: 'wikidata' },
      { source: 'rateyourmusic', url: 'https://rateyourmusic.com/release/album/radiohead/ok-computer', discoveredVia: 'wikidata' },
      { source: 'metacritic', url: 'https://www.metacritic.com/music/ok-computer/radiohead', discoveredVia: 'wikidata' },
      { source: 'wikipedia', url: 'https://en.wikipedia.org/wiki/OK_Computer', discoveredVia: 'wikidata' },
    ]));
    for (const s of ['allmusic', 'rateyourmusic', 'metacritic']) {
      expect(links.filter((l) => l.source === s)).toHaveLength(1);
    }
  });

  it('uses MusicBrainz review / allmusic relationships as direct links', () => {
    const links = resolveReviewLinks({
      ...base,
      mbUrlRelations: [
        { type: 'review', url: 'https://pitchfork.com/reviews/albums/6656-ok-computer/' },
        { type: 'allmusic', url: 'https://www.allmusic.com/album/mw0000024289' },
        { type: 'discogs', url: 'https://www.discogs.com/master/21491' },
      ],
    });
    expect(links).toEqual(expect.arrayContaining([
      { source: 'pitchfork', url: 'https://pitchfork.com/reviews/albums/6656-ok-computer/', discoveredVia: 'mb_relationship' },
      { source: 'allmusic', url: 'https://www.allmusic.com/album/mw0000024289', discoveredVia: 'mb_relationship' },
    ]));
    expect(links.find((l) => l.source === 'pitchfork' && l.discoveredVia === 'template')).toBeUndefined();
    expect(links.find((l) => l.url.includes('discogs.com'))).toBeUndefined();
  });

  it('falls back to search templates for every publication without a direct link', () => {
    const links = resolveReviewLinks(base);
    expect(links.every((l) => l.discoveredVia === 'template')).toBe(true);
    expect(links.map((l) => l.source).sort()).toEqual(Object.keys(SEARCH_TEMPLATES).sort());
    const q = encodeURIComponent('Radiohead OK Computer');
    expect(links.find((l) => l.source === 'pitchfork')?.url).toBe(`https://pitchfork.com/search/?query=${q}`);
    expect(links.every((l) => l.url.includes(q))).toBe(true);
  });

  it('never emits duplicate URLs and never fetches anything (pure)', () => {
    const links = resolveReviewLinks({
      ...base,
      identity: { allmusicId: 'mw1' },
      mbUrlRelations: [{ type: 'allmusic', url: 'https://www.allmusic.com/album/mw1' }],
    });
    expect(new Set(links.map((l) => l.url)).size).toBe(links.length);
    expect(links.filter((l) => l.source === 'allmusic')).toHaveLength(1);
  });
});

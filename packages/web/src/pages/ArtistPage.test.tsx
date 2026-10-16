/**
 * The artist page (approved prototype artist-directions): its words
 * (artistPageView), both layouts rendered for the four states (loading,
 * fetching details, sparse, rich) and a failed fetch, the section navigation
 * of the name-first layout, and the scroll code staying off scroll events.
 */
import { describe, it, expect, vi } from 'vitest';
import { createRef } from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ArtistAlbum, ArtistDetail } from '../hooks';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, children, className }: { to: string; params?: Record<string, string>; children: unknown; className?: string }) => {
    let href = to;
    for (const [k, v] of Object.entries(params ?? {})) href = href.replace(`$${k}`, v);
    return <a href={href} className={className}>{children as never}</a>;
  },
}));

import {
  albumKind, detailsState, kickerLine, kindLine, mosaicAlbums, ownedLine, pageSections, regionName, shelves, yearsLine, SECTION_IDS,
} from './artistPageView';
import { ArtistNameFirst, ArtistNameFirstSkeleton } from './ArtistNameFirst';
import { ArtistLikeAlbums, ArtistLikeAlbumsSkeleton } from './ArtistLikeAlbums';

const album = (over: Partial<ArtistAlbum>): ArtistAlbum => ({
  key: over.localAlbumId ?? `rg:${over.releaseGroupId ?? over.title}`, localAlbumId: null, releaseGroupId: null, title: 'Untitled',
  year: null, primaryType: null, ownership: 'digital', trackCount: null, coverUrl: null, matchedBy: 'tags', ...over,
});

const xtc: ArtistDetail = {
  id: 'x', mbid: 'm', discogsId: null, name: 'XTC', sortName: 'XTC', disambiguation: 'English rock band',
  type: 'Group', country: 'GB', beginDate: '1976-01-01', endDate: '2006-01-01',
  aliases: ['The Beech Avenue Boys', 'The Three Wise Men'],
  bio: { source: 'wikipedia', license: 'CC BY-SA 4.0', text: 'XTC were an English rock band.\nPartridge and Moulding met.\nBetween 1979 and 1992.', url: 'https://en.wikipedia.org/wiki/XTC', title: 'XTC', fetchedAt: '2026-10-11T00:00:00Z' },
  enrichedAt: '2026-10-11T18:11:15Z', enrichError: null, canEnrich: true,
  links: { musicbrainz: 'https://musicbrainz.org/artist/m', wikipedia: 'https://en.wikipedia.org/wiki/XTC' },
  followed: true,
  albums: [
    album({ localAlbumId: 'a1', title: 'Mummer', year: 1983, primaryType: 'Album', trackCount: 16, matchedBy: 'credit', coverUrl: '/api/v1/images/album/a1' }),
    album({ releaseGroupId: 'g1', title: 'Skylarking', year: 1986, primaryType: 'Album', ownership: 'missing', matchedBy: 'gap', gapId: 'gap1' }),
    album({ releaseGroupId: 'g2', title: 'Live Bootleg', year: 1990, primaryType: 'Live', ownership: 'ignored', matchedBy: 'gap', gapId: 'gap2' }),
  ],
  owned: { albums: 1, tracks: 16 },
};

// Aarni: only tag-matched albums, enriched, nothing on Wikipedia
const aarni: ArtistDetail = {
  ...xtc, id: 'aa', name: 'Aarni', disambiguation: null, country: 'FI', beginDate: null, endDate: null, aliases: ['Arni'], bio: null, followed: false,
  links: { musicbrainz: 'https://musicbrainz.org/artist/aa' },
  albums: [
    album({ localAlbumId: 'd', title: 'Demo 2001 + Promo 2002', year: 2003, trackCount: 1 }),
    album({ localAlbumId: 'b', title: 'Bathos', year: 2004, trackCount: 9 }),
  ],
  owned: { albums: 2, tracks: 10 },
};

const layoutProps = (artist: ArtistDetail, maintenance = false, details = detailsState(artist, false)) => ({
  artist, shelves: shelves(artist.albums), details, maintenance,
  nameRef: createRef<HTMLHeadingElement>(), endRef: createRef<HTMLDivElement>(),
  follow: { pending: false, toggle: () => {} }, enrich: { pending: false, run: () => {} },
  onReleaseTypes: () => {}, onReopen: () => {}, reopening: false, canFollow: true,
});
const nameFirst = (artist: ArtistDetail, maintenance = false, details?: ReturnType<typeof detailsState>, active: string | null = null) => {
  const props = layoutProps(artist, maintenance, details);
  const sections = pageSections(artist, props.shelves, maintenance);
  return renderToStaticMarkup(<ArtistNameFirst {...props} sections={sections} active={active ?? sections[0]?.id ?? null} goTo={() => {}} />);
};
const likeAlbums = (artist: ArtistDetail, maintenance = false, details?: ReturnType<typeof detailsState>) =>
  renderToStaticMarkup(<ArtistLikeAlbums {...layoutProps(artist, maintenance, details)} />);

describe('artist page words', () => {
  it('names the country (FI → Finland), and keeps a code it cannot name', () => {
    expect(regionName('FI')).toBe('Finland');
    expect(regionName('gb')).toBe('United Kingdom');
    expect(regionName(null)).toBeNull();
    expect(regionName('not a code')).toBe('not a code');
  });

  it('a group is active between years; a person is born', () => {
    expect(yearsLine({ type: 'Group', beginDate: '1976-01-01', endDate: '2006-01-01' })).toBe('1976–2006');
    expect(yearsLine({ type: 'Group', beginDate: '2010-01-01', endDate: null })).toBe('Since 2010');
    expect(yearsLine({ type: 'Person', beginDate: '1971-06-23', endDate: null })).toBe('Born 1971');
    expect(yearsLine({ type: 'Group', beginDate: null, endDate: null })).toBeNull();
  });

  it('kicker and kind lines', () => {
    expect(kickerLine(xtc)).toBe('Group · United Kingdom · 1976–2006');
    expect(kindLine(aarni)).toBe('Group · Finland');
    expect(kickerLine({ type: null, country: null, beginDate: null, endDate: null })).toBe('');
  });

  it('owned: albums · tracks', () => {
    expect(ownedLine({ albums: 6, tracks: 36 })).toBe('6 albums · 36 tracks');
    expect(ownedLine({ albums: 1, tracks: 16 })).toBe('1 album · 16 tracks');
    expect(ownedLine({ albums: 1, tracks: 0 })).toBe('1 album');
    expect(ownedLine({ albums: 0, tracks: 0 })).toBe('None yet');
  });

  it('an album known only by its tags is an Album; an unknown type is Other', () => {
    expect(albumKind({ primaryType: null })).toBe('Album');
    expect(albumKind({ primaryType: 'EP' })).toBe('EP');
    expect(albumKind({ primaryType: 'Broadcast' })).toBe('Other');
  });

  it('where the details stand: never an endless wait', () => {
    expect(detailsState({ enrichedAt: null, enrichError: null, canEnrich: true }, true)).toBe('fetching');
    // the page stopped polling and nothing came back
    expect(detailsState({ enrichedAt: null, enrichError: null, canEnrich: true }, false)).toBe('stalled');
    expect(detailsState({ enrichedAt: null, enrichError: 'MusicBrainz rate limited', canEnrich: true }, true)).toBe('failed');
    expect(detailsState({ enrichedAt: null, enrichError: null, canEnrich: false }, true)).toBe('none');
    expect(detailsState({ enrichedAt: '2026-10-11T00:00:00Z', enrichError: null, canEnrich: true }, false)).toBe('done');
  });

  it('sections in page order, only those with something in them; Skipped in Maintenance', () => {
    const s = shelves(xtc.albums);
    expect(pageSections(xtc, s, false).map((x) => [x.label, x.count])).toEqual([['Biography', undefined], ['In your library', 1], ['Not in your library', 1]]);
    expect(pageSections(xtc, s, true).map((x) => x.label)).toContain('Skipped');
    expect(pageSections(aarni, shelves(aarni.albums), false).map((x) => x.label)).toEqual(['In your library']);
  });

  it('the mosaic takes covers first, at most four', () => {
    const owned = [1, 2, 3, 4, 5].map((i) => album({ localAlbumId: `l${i}`, title: `T${i}`, coverUrl: i === 5 ? '/c5' : null }));
    expect(mosaicAlbums(owned).map((a) => a.localAlbumId)).toEqual(['l5', 'l1', 'l2', 'l3']);
  });
});

describe('name first (B, the default)', () => {
  it('rich: kicker, the name, aliases, the bio, both album sections; the column is the section navigation', () => {
    const html = nameFirst(xtc, false, 'done', SECTION_IDS.owned);
    expect(html).toContain('Group · United Kingdom · 1976–2006');
    expect(html).toMatch(/<h1[^>]*>XTC<\/h1>/);
    expect(html).toContain('Also known as <em>The Beech Avenue Boys, The Three Wise Men</em>');
    expect(html).toContain('1 album · 16 tracks');
    expect(html).toMatch(/id="artist-biography"[\s\S]*Biography/);
    expect(html).toMatch(/id="artist-in-library"[\s\S]*In your library/);
    expect(html).toMatch(/id="artist-not-in-library"[\s\S]*Not in your library/);
    // the rail and the one-column row: links to each section, the current one marked
    const navs = html.match(/<nav[^>]*aria-label="Sections"[\s\S]*?<\/nav>/g) ?? [];
    expect(navs).toHaveLength(2);
    for (const nav of navs) {
      expect(nav).toContain('href="#artist-biography"');
      expect(nav).toContain('href="#artist-not-in-library"');
      expect(nav.match(/aria-current="location"/g)).toHaveLength(1);
      expect(nav).toMatch(/href="#artist-in-library" aria-current="location"/);
    }
    // the owned album links to its album page; skipped ones stay out of the plain view
    expect(html).toContain('href="/albums/a1"');
    expect(html).not.toContain('Live Bootleg');
    expect(html).not.toContain('Fetching details');
  });

  it('sparse: reads complete — "None on Wikipedia", no empty boxes, no section navigation for one section', () => {
    const html = nameFirst(aarni, false, 'done');
    expect(html).toContain('Group · Finland');
    expect(html).toContain('None on Wikipedia');
    expect(html).toContain('2 albums · 10 tracks');
    expect(html).toContain('Bathos');
    expect(html).not.toContain('aria-label="Sections"');
    expect(html).not.toContain('Not in your library');
    expect(html).not.toContain('Biography</h2>');
  });

  it('fetching: the calm note for everyone, no kicker, no "None on Wikipedia" yet', () => {
    const html = nameFirst({ ...aarni, enrichedAt: null, type: null, country: null }, false, 'fetching');
    expect(html).toMatch(/role="status"[^>]*>.*Fetching details from MusicBrainz and Wikipedia/);
    expect(html).not.toContain('None on Wikipedia');
  });

  it('failed: plainly said; Retry only in Maintenance; stalled says nothing', () => {
    const failed = { ...aarni, enrichedAt: null, enrichError: 'boom' };
    expect(nameFirst(failed, false, 'failed')).toContain('Couldn’t fetch details.');
    expect(nameFirst(failed, false, 'failed')).not.toContain('Retry');
    expect(nameFirst(failed, true, 'failed')).toContain('Retry');
    const stalled = nameFirst({ ...aarni, enrichedAt: null }, false, 'stalled');
    expect(stalled).not.toContain('Fetching details');
    expect(stalled).not.toContain('Couldn’t');
  });

  it('Maintenance: provider links, Refresh details, Release types (followed), when, and the skipped releases', () => {
    const html = nameFirst(xtc, true, 'done');
    expect(html).toContain('MusicBrainz');
    expect(html).toContain('Refresh details');
    expect(html).toContain('Release types');
    expect(html).toContain('Details from 11 Oct 2026');
    expect(html).toContain('Live Bootleg');
    expect(html).toContain('href="#artist-skipped"');
  });

  it('loading: soft shapes only', () => {
    const html = renderToStaticMarkup(<ArtistNameFirstSkeleton />);
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toMatch(/<h1/);
  });
});

describe('like albums (A)', () => {
  it('rich: the kind line, facts in a row, the bio lede, tabs, the albums by kind and what is missing', () => {
    const html = likeAlbums(xtc, false, 'done');
    expect(html).toContain('Group · United Kingdom');
    expect(html).toMatch(/<dt>From<\/dt><dd[^>]*>United Kingdom<\/dd>/);
    expect(html).toMatch(/<dt>Active<\/dt><dd[^>]*>1976–2006<\/dd>/);
    expect(html).toMatch(/<dt>In your library<\/dt><dd[^>]*>1 album · 16 tracks<\/dd>/);
    expect(html).toContain('XTC were an English rock band.');
    expect(html).toContain('Read more');
    expect(html).toMatch(/role="tab"[\s\S]*Albums[\s\S]*role="tab"[\s\S]*Biography/);
    expect(html).toContain('Not in your library · 1');
    // the mosaic: the owned album's cover, decorative
    expect(html).toMatch(/data-n="1"[^>]*aria-hidden="true"[\s\S]*src="\/api\/v1\/images\/album\/a1"/);
  });

  it('sparse: no photo needed — the mosaic of owned covers; "None on Wikipedia"; one tab', () => {
    const html = likeAlbums(aarni, false, 'done');
    expect(html).toMatch(/data-n="2"/);
    expect(html).toContain('None on Wikipedia');
    expect(html).toMatch(/<dt>Also known as<\/dt><dd[^>]*>Arni<\/dd>/);
    expect(html).not.toContain('Biography</span>');
  });

  it('fetching: the fetch line above the name, bars where the facts land', () => {
    const html = likeAlbums({ ...aarni, enrichedAt: null }, false, 'fetching');
    expect(html).toContain('Fetching details from MusicBrainz and Wikipedia');
    expect(html).not.toContain('Group · Finland');
  });

  it('loading', () => {
    expect(renderToStaticMarkup(<ArtistLikeAlbumsSkeleton />)).toContain('aria-busy="true"');
  });
});

describe('scrolling stays cheap', () => {
  const flow = readFileSync(new URL('./useArtistFlow.ts', import.meta.url), 'utf8');
  it('docking and the scroll-spy are IntersectionObservers, not scroll or resize handlers', () => {
    expect(flow).toMatch(/new IntersectionObserver/);
    expect(flow).not.toMatch(/addEventListener\(\s*['"](scroll|resize)['"]/);
  });
  it('a click scrolls smoothly unless reduced motion is asked for', () => {
    expect(flow).toMatch(/prefers-reduced-motion: reduce/);
    expect(flow).toMatch(/behavior: smooth \? 'smooth' : 'auto'/);
  });
});

/**
 * The artist page's words and structure, free of React: the lines the two
 * layouts print (kind, country, years, what you own) and which sections the
 * page has. Both layouts (ArtistNameFirst, ArtistLikeAlbums) read from here.
 */
import type { ArtistAlbum, ArtistDetail } from '../hooks';

const displayNames = new Map<string, Intl.DisplayNames | null>();

/** A country code as a name ("FI" → "Finland"); the code itself when the browser cannot name it. */
export function regionName(code: string | null | undefined, locale = 'en'): string | null {
  if (!code) return null;
  let names = displayNames.get(locale);
  if (names === undefined) {
    try {
      names = new Intl.DisplayNames([locale], { type: 'region' });
    } catch {
      names = null;
    }
    displayNames.set(locale, names);
  }
  try {
    return names?.of(code.toUpperCase()) ?? code;
  } catch {
    return code; // not a region code (MusicBrainz "XW" world, "XE" Europe are; junk is not)
  }
}

const year = (date: string | null | undefined): string | null => (date ? date.slice(0, 4) : null);

/**
 * The artist's years: a group's active years ("1976–2006", "Since 1976"),
 * a person's life ("Born 1971", "1940–2016"). Null when MusicBrainz has none.
 */
export function yearsLine(artist: Pick<ArtistDetail, 'type' | 'beginDate' | 'endDate'>): string | null {
  const from = year(artist.beginDate);
  const to = year(artist.endDate);
  if (!from) return null;
  if (to) return from === to ? from : `${from}–${to}`;
  return artist.type === 'Person' ? `Born ${from}` : `Since ${from}`;
}

/** "Group · Finland" (A's line above the name, the docked header). */
export function kindLine(artist: Pick<ArtistDetail, 'type' | 'country'>): string {
  return [artist.type, regionName(artist.country)].filter(Boolean).join(' · ');
}

/** "Group · United Kingdom · 1976–2006" (B's kicker). */
export function kickerLine(artist: Pick<ArtistDetail, 'type' | 'country' | 'beginDate' | 'endDate'>): string {
  return [artist.type, regionName(artist.country), yearsLine(artist)].filter(Boolean).join(' · ');
}

/** "6 albums · 36 tracks"; an album on the shelf only has no tracks on disk. */
export function ownedLine(owned: ArtistDetail['owned']): string {
  if (owned.albums === 0) return 'None yet';
  const albums = `${owned.albums} ${owned.albums === 1 ? 'album' : 'albums'}`;
  return owned.tracks > 0 ? `${albums} · ${owned.tracks} ${owned.tracks === 1 ? 'track' : 'tracks'}` : albums;
}

/** The release kinds A groups the albums by, in this order. */
export const ALBUM_KINDS = ['Album', 'EP', 'Single', 'Live', 'Compilation', 'Other'] as const;
export type AlbumKind = (typeof ALBUM_KINDS)[number];

/** An album's kind: its release group's type (Broadcast and the like: Other); no type known (tags alone): Album. */
export function albumKind(album: Pick<ArtistAlbum, 'primaryType'>): AlbumKind {
  const t = album.primaryType;
  if (t && (ALBUM_KINDS as readonly string[]).includes(t)) return t as AlbumKind;
  return t ? 'Other' : 'Album';
}

export const KIND_HEADINGS: Record<AlbumKind, string> = {
  Album: 'Albums', EP: 'EPs', Single: 'Singles', Live: 'Live', Compilation: 'Compilations', Other: 'Other releases',
};

export interface ArtistShelves {
  /** on disk or on the shelf, oldest first */
  owned: ArtistAlbum[];
  /** a followed artist's missing releases */
  missing: ArtistAlbum[];
  /** missing releases the owner chose to skip (Maintenance only) */
  skipped: ArtistAlbum[];
}

export function shelves(albums: ArtistAlbum[]): ArtistShelves {
  return {
    owned: albums.filter((a) => a.ownership === 'digital' || a.ownership === 'both' || a.ownership === 'physical'),
    missing: albums.filter((a) => a.ownership === 'missing'),
    skipped: albums.filter((a) => a.ownership === 'ignored'),
  };
}

/**
 * Where the details stand:
 *  - fetching: on their way (the page says so, with a spinner);
 *  - failed: the last fetch failed (Maintenance offers Retry);
 *  - stalled: not fetched, and the page stopped waiting (no error came back);
 *  - none: the artist has no MusicBrainz id, so there is nothing to fetch;
 *  - done.
 */
export type DetailsState = 'fetching' | 'failed' | 'stalled' | 'none' | 'done';

export function detailsState(artist: Pick<ArtistDetail, 'enrichedAt' | 'enrichError' | 'canEnrich'>, waiting: boolean): DetailsState {
  if (artist.canEnrich === false) return 'none';
  if (artist.enrichError) return 'failed';
  if (artist.enrichedAt) return 'done';
  return waiting ? 'fetching' : 'stalled';
}

export interface PageSection {
  id: string;
  label: string;
  count?: number;
}

export const SECTION_IDS = {
  bio: 'artist-biography',
  owned: 'artist-in-library',
  missing: 'artist-not-in-library',
  skipped: 'artist-skipped',
} as const;

/** The sections B's page has, in page order: only those with something in them. */
export function pageSections(artist: Pick<ArtistDetail, 'bio'>, s: ArtistShelves, maintenance: boolean): PageSection[] {
  const out: PageSection[] = [];
  if (artist.bio) out.push({ id: SECTION_IDS.bio, label: 'Biography' });
  if (s.owned.length) out.push({ id: SECTION_IDS.owned, label: 'In your library', count: s.owned.length });
  if (s.missing.length) out.push({ id: SECTION_IDS.missing, label: 'Not in your library', count: s.missing.length });
  if (maintenance && s.skipped.length) out.push({ id: SECTION_IDS.skipped, label: 'Skipped', count: s.skipped.length });
  return out;
}

/** The biography's paragraphs (Wikipedia's intro extract separates them with newlines). */
export function paragraphs(text: string): string[] {
  return text.split(/\n+/).map((p) => p.trim()).filter(Boolean);
}

/** Up to four owned albums for A's mosaic: those with a cover first, then by year. */
export function mosaicAlbums(owned: ArtistAlbum[]): ArtistAlbum[] {
  const withCover = owned.filter((a) => a.coverUrl);
  const without = owned.filter((a) => !a.coverUrl);
  return [...withCover, ...without].slice(0, 4);
}

/** "11 Oct 2026" */
export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

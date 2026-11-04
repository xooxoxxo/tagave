/**
 * Small, pure pieces of the artists browser: the quiet meta line, the cover
 * mosaic layout, and the remembered Grid/List choice.
 */
import { ARTIST_GROUP_ORDER } from '@tagave/shared';
import type { ArtistSort } from '../hooks/useArtists';

/** /artists in the URL: the search's words, the sort (name is the default) and the letter. */
export interface ArtistsSearch {
  q?: string;
  sort?: Exclude<ArtistSort, 'name'>;
  letter?: string;
}

export function parseArtistsSearch(raw: Record<string, unknown>): ArtistsSearch {
  const out: ArtistsSearch = {};
  const q = raw['q'];
  if (typeof q === 'string' && q.trim()) out.q = q.trim();
  const sort = raw['sort'];
  if (sort === 'albums' || sort === 'recent') out.sort = sort;
  const letter = raw['letter'];
  if (typeof letter === 'string' && (ARTIST_GROUP_ORDER as readonly string[]).includes(letter)) out.letter = letter;
  return out;
}

export type ArtistsView = 'grid' | 'list';

export const ARTIST_SORT_OPTIONS: Array<{ value: ArtistSort; label: string }> = [
  { value: 'name', label: 'Name A–Z' },
  { value: 'albums', label: 'Most albums' },
  { value: 'recent', label: 'Recently added' },
];

/** "1994–2012", "2003", or null when no album has a year. */
export function yearsLabel(from: number | null, to: number | null): string | null {
  if (!from && !to) return null;
  if (!from || !to || from === to) return String(from || to);
  return `${from}–${to}`;
}

/** "12 albums · 1994–2012" */
export function artistMeta(artist: { albumCount: number; yearFrom: number | null; yearTo: number | null }): string {
  const albums = `${artist.albumCount.toLocaleString()} ${artist.albumCount === 1 ? 'album' : 'albums'}`;
  const years = yearsLabel(artist.yearFrom, artist.yearTo);
  return years ? `${albums} · ${years}` : albums;
}

/** The mosaic shows at most four covers; 1, 2, 3 and 4 each have a layout. */
export function mosaicCovers(ids: string[] | undefined): string[] {
  return (ids ?? []).slice(0, 4);
}

export const IDENTITY_HINT = {
  linked: 'Identified artist: opens the profile and discography',
  local: 'From your tags only: opens their albums',
} as const;

const VIEW_KEY = 'tagave-artists-view';

/** The Grid/List choice is a per-browser convenience; storage may be missing or throw. */
export function readArtistsView(): ArtistsView {
  try {
    return globalThis.localStorage?.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

export function writeArtistsView(view: ArtistsView): void {
  try {
    if (view === 'grid') globalThis.localStorage?.removeItem(VIEW_KEY);
    else globalThis.localStorage?.setItem(VIEW_KEY, view);
  } catch {
    /* private window or blocked storage: the choice lasts for this visit */
  }
}

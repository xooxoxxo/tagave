/**
 * Listen elsewhere (the listen-links module; vault "tagave - External
 * Players Scoping", phase 1): links from an album to the streaming
 * platforms each person picked. Links only: no platform account, no API
 * key, nothing about the person leaves the server.
 *
 *   exact    the platform's album page (MusicBrainz, Wikidata, Apple's UPC lookup)
 *   artist   the album's artist on the platform (no album link known)
 *   search   the platform's search for "<artist> <album>" (built, never stored)
 */
import { z } from 'zod';

/** In the order Settings › Listen elsewhere lists them. Deezer is listed last and stays unticked like the rest. */
export const LISTEN_PLATFORMS = ['qobuz', 'spotify', 'apple', 'youtube-music', 'tidal', 'bandcamp', 'amazon', 'deezer'] as const;
export const listenPlatformSchema = z.enum(LISTEN_PLATFORMS);
export type ListenPlatform = z.infer<typeof listenPlatformSchema>;

export const LISTEN_PLATFORM_NAMES: Readonly<Record<ListenPlatform, string>> = {
  qobuz: 'Qobuz',
  spotify: 'Spotify',
  apple: 'Apple Music',
  'youtube-music': 'YouTube Music',
  tidal: 'Tidal',
  bandcamp: 'Bandcamp',
  amazon: 'Amazon Music',
  deezer: 'Deezer',
};

export type ListenLinkKind = 'exact' | 'artist' | 'search';

/** Where a stored link came from (listen_links.source). */
export type ListenLinkSource = 'mb-release' | 'mb-artist' | 'wikidata' | 'itunes-upc';

/**
 * The platform's search for a query. Qobuz searches on play.qobuz.com, which
 * opens the Qobuz app on Android.
 */
export function listenSearchUrl(platform: ListenPlatform, query: string): string {
  const q = encodeURIComponent(query.replace(/\s+/g, ' ').trim());
  switch (platform) {
    case 'qobuz': return `https://play.qobuz.com/search?q=${q}`;
    case 'spotify': return `https://open.spotify.com/search/${q}`;
    case 'apple': return `https://music.apple.com/search?term=${q}`;
    case 'youtube-music': return `https://music.youtube.com/search?q=${q}`;
    case 'tidal': return `https://tidal.com/search?q=${q}`;
    case 'bandcamp': return `https://bandcamp.com/search?q=${q}&item_type=a`;
    case 'amazon': return `https://music.amazon.com/search/${q}`;
    case 'deezer': return `https://www.deezer.com/search/${q}`;
  }
}

/** One platform's link for one album, as the Listen control shows it. */
export interface ListenLinkView {
  platform: ListenPlatform;
  /** "Qobuz" */
  name: string;
  url: string;
  kind: ListenLinkKind;
}

/** GET …/release-groups/:rgId/listen-links: the caller's platforms, in their order. */
export interface AlbumListenLinksView {
  /** false when the module is off: nothing shows */
  available: boolean;
  links: ListenLinkView[];
  /** a lookup is on its way: ask again in a little while */
  pending: boolean;
}

/** GET …/artists/:artistId/listen-links: links for each album the artist is missing, by release group id. */
export interface ArtistListenLinksView {
  available: boolean;
  albums: Record<string, ListenLinkView[]>;
  pending: boolean;
}

/** GET/PUT /api/v1/me/listen-links: the person's own platforms, in order. */
export interface ListenPrefsView {
  available: boolean;
  platforms: ListenPlatform[];
}

export const listenPrefsSchema = z.object({
  platforms: z.array(listenPlatformSchema).max(LISTEN_PLATFORMS.length).refine((p) => new Set(p).size === p.length, 'each platform once'),
}).strict();

/** Settings › Modules: the Listen elsewhere row. */
export interface ListenLinksModuleView {
  enabled: boolean;
  /** albums and artists with stored links */
  albums: number;
  artists: number;
  /** people who picked at least one platform */
  people: number;
}

export const listenLinksModuleSchema = z.object({ enabled: z.boolean() }).strict();

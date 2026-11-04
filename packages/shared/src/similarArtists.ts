/**
 * Similar artists (the similar-artists module; api › routes/similarArtists.ts).
 */
import { z } from 'zod';
import type { ListenLinkView, ListenPlatform } from './listenLinks.js';

export type SimilarArtistSource = 'listenbrainz' | 'lastfm';

/** The section shows at most this many: the library's first (up to IN_LIBRARY), then the rest. */
export const SIMILAR_SHOWN = 16;
export const SIMILAR_IN_LIBRARY_MAX = 8;
export const SIMILAR_ELSEWHERE_MAX = 12;

/** An artist in the library: its tagave page, its picture, how much of it you own. */
export interface SimilarInLibraryView {
  artistId: string;
  name: string;
  /** up to four album ids with a front cover (the artist card's mosaic) */
  coverAlbumIds: string[];
  albums: number;
}

/** An artist not in the library: dimmed, Follow, Listen elsewhere. */
export interface SimilarElsewhereView {
  mbid: string | null;
  name: string;
  /** MusicBrainz's short description ("UK rock band"), when it has one */
  comment: string | null;
  /** tagave's artist row, when it has one (a credit, a follow) */
  artistId: string | null;
  followed: boolean;
  /** the person's Listen elsewhere platforms: the artist's page, else a search */
  listen: ListenLinkView[];
}

/** GET /api/v1/libraries/:libraryId/artists/:artistId/similar */
export interface ArtistSimilarView {
  /** false when the module is off: the section hides */
  available: boolean;
  /** the first fetch is on its way: ask again in a little while */
  pending: boolean;
  inLibrary: SimilarInLibraryView[];
  elsewhere: SimilarElsewhereView[];
  /** the person's primary Listen elsewhere platform */
  primary: ListenPlatform | null;
}

/** POST …/similar/follow: follow an artist the library has no row for yet, by MBID. */
export const similarFollowSchema = z.object({
  mbid: z.string().uuid(),
  name: z.string().trim().min(1).max(255),
}).strict();

/** Settings › Modules › Similar artists. */
export interface SimilarArtistsModuleView {
  enabled: boolean;
  /** artists with a fetched list */
  artists: number;
  /** similar artists stored */
  similar: number;
  /** the install has a Last.fm API key: Last.fm's list is merged in */
  lastfm: boolean;
}

export const similarArtistsModuleSchema = z.object({ enabled: z.boolean() }).strict();

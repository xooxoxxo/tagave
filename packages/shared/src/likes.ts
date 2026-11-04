/**
 * Likes (0085): each person's hearts on songs, albums and artists.
 *
 *   GET    /api/v1/me/likes                     what is liked, as ids the app can test: { songs, albums, artists }
 *   GET    /api/v1/me/likes/songs               Liked songs, newest first
 *   PUT    /api/v1/me/likes/:kind/:id           like (song: a local track; album: a local album; artist: an artist)
 *   DELETE /api/v1/me/likes/:kind/:id           unlike
 *   PUT    /api/v1/me/listening/:service/loves  { on } send liked songs as loves (Last.fm, ListenBrainz)
 */
import { z } from 'zod';

export const LIKE_KINDS = ['song', 'album', 'artist'] as const;
export const likeKindSchema = z.enum(LIKE_KINDS);
export type LikeKind = z.infer<typeof likeKindSchema>;

/**
 * GET /api/v1/me/likes: everything liked, as the ids the app shows. songs are
 * local track ids (every copy of a liked recording), albums local album ids
 * (every copy of a liked release group), artists artist ids.
 */
export interface LikeKeysView {
  songs: string[];
  albums: string[];
  artists: string[];
}

/** One row of Liked songs. */
export interface LikedSongView {
  /** the like */
  id: string;
  /** null: the song is not in the library (any more) */
  localTrackId: string | null;
  albumId: string | null;
  title: string;
  artist: string | null;
  album: string | null;
  coverUrl: string | null;
  durationMs: number | null;
  likedAt: string;
  /** the album's first credited artist (Go to artist) */
  artistLink: { id: string; name: string } | null;
}

/** GET /api/v1/me/likes/songs */
export interface LikedSongsView {
  count: number;
  durationMs: number;
  /** up to four album covers, newest like first */
  covers: string[];
  items: LikedSongView[];
}

/** PUT /api/v1/me/listening/:service/loves */
export const lovesSettingSchema = z.object({ on: z.boolean() }).strict();

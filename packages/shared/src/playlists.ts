/**
 * Playlists (the playlists module, 0056): each person's private lists of
 * tracks, with an export file another tagave can import.
 */
import { z } from 'zod';

export const playlistNameSchema = z.string().trim().min(1).max(200);

/** GET /api/v1/me/playlists */
export interface PlaylistSummary {
  id: string;
  name: string;
  tracks: number;
  durationMs: number;
  /** up to four album cover URLs, in the list's order: the mosaic */
  covers: string[];
  updatedAt: string;
}

export interface PlaylistItemView {
  id: string;
  /** null: the track is not in the library (any more) — "Missing" */
  localTrackId: string | null;
  albumId: string | null;
  title: string;
  artist: string | null;
  album: string | null;
  coverUrl: string | null;
  durationMs: number | null;
}

/** GET /api/v1/me/playlists/:id */
export interface PlaylistView extends PlaylistSummary {
  items: PlaylistItemView[];
}

/** POST /api/v1/me/playlists */
export const createPlaylistSchema = z.object({
  name: playlistNameSchema,
  /** tracks to start it with (the queue, "Save as playlist") */
  trackIds: z.array(z.string().uuid()).max(5000).optional(),
}).strict();

/** PATCH /api/v1/me/playlists/:id: rename, or the items' new order (every item id once). */
export const patchPlaylistSchema = z.object({
  name: playlistNameSchema.optional(),
  order: z.array(z.string().uuid()).max(10000).optional(),
}).strict().refine((b) => b.name !== undefined || b.order !== undefined, 'name or order');

/** POST /api/v1/me/playlists/:id/items: tracks, or every track of an album, at the end. */
export const addPlaylistItemsSchema = z.object({
  trackIds: z.array(z.string().uuid()).max(5000).optional(),
  albumId: z.string().uuid().optional(),
}).strict().refine((b) => (b.trackIds?.length ?? 0) > 0 || !!b.albumId, 'trackIds or albumId');

/** The export file, *.tagave-playlist.json. No file paths: they say how someone's disks are laid out. */
export const PLAYLIST_FILE_FORMAT = 'tagave-playlist';
export const PLAYLIST_FILE_VERSION = 1;

export const playlistFileItemSchema = z.object({
  recordingMbid: z.string().max(36).nullable().optional(),
  releaseMbid: z.string().max(36).nullable().optional(),
  discNo: z.number().int().nullable().optional(),
  trackNo: z.number().int().nullable().optional(),
  title: z.string().max(1000),
  artist: z.string().max(1000).nullable().optional(),
  album: z.string().max(1000).nullable().optional(),
  durationMs: z.number().int().nullable().optional(),
});
export type PlaylistFileItem = z.infer<typeof playlistFileItemSchema>;

export const playlistFileSchema = z.object({
  format: z.literal(PLAYLIST_FILE_FORMAT),
  version: z.literal(PLAYLIST_FILE_VERSION),
  exportedAt: z.string().optional(),
  generator: z.string().optional(),
  playlists: z.array(z.object({
    name: z.string().max(1000),
    /** the module-wide export names whose list it was; an import ignores it */
    owner: z.string().max(500).optional(),
    createdAt: z.string().optional(),
    items: z.array(playlistFileItemSchema).max(20000),
  })).max(1000),
});
export type PlaylistFile = z.infer<typeof playlistFileSchema>;

/** POST /api/v1/me/playlists/import: the file's text; its kind is read from the content. */
export const importPlaylistsSchema = z.object({
  /** the file's name, for an m3u8 or xspf playlist's name */
  fileName: z.string().max(500).optional(),
  content: z.string().min(1).max(20_000_000),
}).strict();

export interface PlaylistImportResult {
  playlists: Array<{ id: string; name: string; tracks: number; matched: number; missing: number }>;
}

/** GET/PUT /api/v1/settings/playlists: the Settings › Modules row. */
export interface PlaylistsModuleView {
  enabled: boolean;
  playlists: number;
  people: number;
}
export const playlistsModuleSchema = z.object({ enabled: z.boolean() }).strict();

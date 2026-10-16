import { z } from 'zod';

/**
 * The opt-in player module: tagave plays albums through a Navidrome (or any
 * Subsonic-compatible) server. Either the bundled one (compose profile
 * "player", TAGAVE_PLAYER_URL in the app's environment) or one the owner
 * already runs (Settings › Playback, "bring your own"). The browser never
 * talks to that server: the API resolves tracks, proxies the audio and
 * records play events, so its password never leaves the server.
 */

/** Where the player backend comes from. */
export const playerManagedSchema = z.enum(['bundled', 'external']);
export type PlayerManaged = z.infer<typeof playerManagedSchema>;

/** Is a player backend configured, and does it answer? Every signed-in user may read it. */
export const playerCapabilitySchema = z.object({
  /** a backend is configured (bundled or bring-your-own); false hides every Play control */
  installed: z.boolean(),
  managed: playerManagedSchema.nullable(),
  /** the server's own name for itself (OpenSubsonic `type`, e.g. "navidrome"), when it answered */
  backend: z.string().nullable(),
  /** its version (OpenSubsonic `serverVersion`), when it answered */
  version: z.string().nullable(),
  /** it answered a signed ping within a few seconds (cached for 30 s) */
  reachable: z.boolean(),
  /** why not, in plain words, when installed but not reachable */
  error: z.string().nullable(),
});
export type PlayerCapability = z.infer<typeof playerCapabilitySchema>;

/** GET /api/v1/capabilities */
export interface CapabilitiesView {
  player: PlayerCapability;
}

/**
 * GET /api/v1/libraries/:libraryId/player: the capability plus, for the
 * owner, the settings behind it (never a password).
 */
export interface PlayerSettingsView {
  capability: PlayerCapability;
  /** the bundled server is configured through .env; when true the external fields are ignored */
  bundled: boolean;
  external: {
    url: string;
    username: string;
    /** last four characters of the saved password, for recognition */
    passwordHint: string | null;
  } | null;
  /** the last scan tagave asked the server for, and how it went */
  lastScan: { requestedAt: string; state: 'requested' | 'failed'; error: string | null } | null;
}

/** PUT /api/v1/libraries/:libraryId/player/server (owner): bring your own server. */
export const savePlayerServerSchema = z.object({
  url: z.string().trim().url().max(2048).refine((u) => /^https?:\/\//i.test(u), 'Use an http:// or https:// address'),
  username: z.string().trim().min(1).max(255),
  /** omitted keeps the saved password (changing only the address or user) */
  password: z.string().min(1).max(1024).optional(),
}).strict();
export type SavePlayerServer = z.infer<typeof savePlayerServerSchema>;

/**
 * Why a track cannot be played right now:
 *  - not_scanned  the server has not seen the file yet (tagave asked it to scan)
 *  - no_file      the file is missing or unreadable in tagave's own scan
 *  - cue          a track inside a CUE image (one file, many tracks): not supported yet
 */
export const unplayableReasonSchema = z.enum(['not_scanned', 'no_file', 'cue']);
export type UnplayableReason = z.infer<typeof unplayableReasonSchema>;

/** One entry of an album's play queue. */
export interface PlayerQueueTrack {
  /** local_tracks.id: the id the stream and event endpoints take */
  localTrackId: string;
  discNo: number;
  trackNo: number | null;
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  durationMs: number | null;
  /** the file's container and codec as tagave read them, to choose original or transcoded audio */
  container: string | null;
  codec: string | null;
  lossless: boolean | null;
  /** the MIME type of the original file, for HTMLMediaElement.canPlayType */
  mime: string | null;
  available: boolean;
  reason: UnplayableReason | null;
}

/** GET /api/v1/player/albums/:albumId/queue (albumId = local_albums.id) */
export interface PlayerQueueView {
  albumId: string;
  album: string;
  albumArtist: string;
  /** tagave's own cover art, the same URL the album page uses */
  coverUrl: string | null;
  /** disc, then track order; unavailable tracks are included (the UI skips them) */
  tracks: PlayerQueueTrack[];
  /** some files were not on the server yet, so tagave asked it to scan */
  scanRequested: boolean;
  /** the server's scan, when some tracks are not on it yet (absent from an older API) */
  scan?: PlayerScanStatus | null;
}

/**
 * The player server's own scan (Subsonic getScanStatus): while it runs, the
 * albums it has not reached are not playable yet. Navidrome reads a new
 * library in folder order, so a big first scan takes a while.
 */
export interface PlayerScanStatus {
  scanning: boolean;
  /** the server has never finished a scan (no lastScan): this is its first */
  firstScan: boolean;
  /** files the server has read in this scan, as it reports them */
  count: number | null;
  /** the audio files tagave knows in this library, the scan's goal */
  total: number | null;
  /** count / total while a first scan runs (never 100 before it ends); null otherwise */
  percent: number | null;
}

/**
 * GET /api/v1/player/albums/:albumId/availability: can Play start on this
 * album now? Read-only: it matches tracks to songs like the queue does, but
 * never asks the server to scan.
 */
export interface PlayerAlbumAvailability {
  albumId: string;
  tracks: number;
  /** tracks the player can stream now */
  playable: number;
  /** why the first unplayable track is not playable, when none is */
  reason: UnplayableReason | null;
  /** the server's scan, when some tracks are not on it yet */
  scan: PlayerScanStatus | null;
}

/** Stream formats. `original` passes the file through untouched (seekable with HTTP ranges). */
export const STREAM_FORMATS = ['original', 'opus', 'aac', 'mp3'] as const;
export const streamFormatSchema = z.enum(STREAM_FORMATS);
export type StreamFormat = z.infer<typeof streamFormatSchema>;
export const STREAM_BITRATES = [96, 128, 160, 192, 256, 320] as const;

/** GET /api/v1/player/stream/:localTrackId query */
export const streamQuerySchema = z.object({
  format: streamFormatSchema.default('original'),
  /** kbps for a transcoded stream; ignored for original */
  maxBitRate: z.coerce.number().int().refine((n) => (STREAM_BITRATES as readonly number[]).includes(n), 'Unsupported bitrate').optional(),
  /** seconds into the track a transcoded stream starts at (a transcode cannot seek with ranges) */
  offset: z.coerce.number().int().min(0).max(24 * 3600).optional(),
});
export type StreamQuery = z.infer<typeof streamQuerySchema>;

/**
 * The player's per-device quality choice (Settings › Playback, kept in this
 * browser): auto plays the original when the browser can and the file is
 * not huge for the connection, otherwise transcodes.
 */
export const playerQualitySchema = z.object({
  format: z.enum(['auto', 'original', 'opus', 'aac', 'mp3']).default('auto'),
  bitrate: z.number().int().refine((n) => (STREAM_BITRATES as readonly number[]).includes(n)).default(192),
});
export type PlayerQuality = z.infer<typeof playerQualitySchema>;
export const PLAYER_QUALITY_STORAGE_KEY = 'tagave-player-quality';

/**
 * Play events: the web player reports them, the API stores them as they
 * come. A later round turns them into listens (≥50% of an album within 6 h)
 * and scrobbles; nothing reads them yet.
 *
 *  - now_playing  a track started (or resumed after a seek past the start)
 *  - completed    a track played to its end
 *  - skipped      the listener moved on before the end
 */
export const playEventKindSchema = z.enum(['now_playing', 'completed', 'skipped']);
export type PlayEventKind = z.infer<typeof playEventKindSchema>;

export const playEventSchema = z.object({
  kind: playEventKindSchema,
  localTrackId: z.string().uuid(),
  /** a random id per queue the browser started (Play on an album), to group one listening session */
  queueId: z.string().uuid(),
  /** milliseconds of this track actually heard (not the position: seeks do not count) */
  playedMs: z.number().int().min(0).max(24 * 3600_000),
  positionMs: z.number().int().min(0).max(24 * 3600_000),
  /** when it happened on the client, if it was queued while offline; the server clamps it */
  at: z.string().datetime().optional(),
}).strict();
export type PlayEvent = z.infer<typeof playEventSchema>;

/**
 * DJ (the dj module; api › routes/dj.ts, vault "tagave - DJ Module"): what
 * the player's DJ engine reads about the tracks it mixes, and the module's
 * Settings › Modules page. While the module is off every /me/dj route
 * answers 404.
 */
import { z } from 'zod';

/** At most this many ids per GET /me/dj/tracks and POST /me/dj/analyze. */
export const DJ_TRACKS_MAX = 50;

/**
 * GET /api/v1/me/dj/tracks?ids=a,b,c (player.use): one per id asked for that
 * exists, in the order asked. The analysis fields are null until dj.analyze
 * has measured the track (the request queues it); bpm and firstBeatMs are
 * also null when the track has no steady pulse, the trim points when it is
 * silent throughout.
 */
export interface DjTrackInfo {
  localTrackId: string;
  /** beats per minute (80–180, three decimals) */
  bpm: number | null;
  /** 0–1 */
  bpmConfidence: number | null;
  /** the beat grid: firstBeatMs + k · 60000 / bpm */
  firstBeatMs: number | null;
  /** where the sound starts and ends (−45 dBFS RMS, 20 ms windows), from the track's start */
  trimStartMs: number | null;
  trimEndMs: number | null;
  durationMs: number;
  /** a stable id of the track's album (the local album): gapless detection */
  albumKey: string | null;
  trackNo: number | null;
  discNo: number | null;
}

/** GET /api/v1/me/dj/peaks/:localTrackId (player.use): the Advanced decks' waveform. */
export interface DjPeaks {
  /** 0–1, ~900 bins over the whole track */
  peaks: number[];
}

/** POST /api/v1/me/dj/analyze (player.use): measure these tracks next (the queue's next few). */
export const djAnalyzeSchema = z.object({
  localTrackIds: z.array(z.string().uuid()).min(1).max(DJ_TRACKS_MAX),
}).strict();

export interface DjAnalyzeResult {
  /** tracks sent to the analysis queue (the others are measured or already on their way) */
  queued: number;
}

/**
 * The module's settings (crossfade, beat-aligned, …): placeholder, filled
 * by the player engine's part of the module.
 */
export type DjSettings = Record<string, unknown>;

/** GET/PUT /api/v1/settings/dj (system.manage): Settings › Modules › DJ. */
export interface DjModuleView {
  enabled: boolean;
  /** tracks measured (without an error) */
  analyzed: number;
  /** tracks in the library */
  tracks: number;
  settings: DjSettings;
}

export const djModuleSchema = z.object({ enabled: z.boolean() }).strict();

/**
 * Simple mode, each person's own (Settings › Modules › DJ): kept in their
 * user_prefs row (0087, GET/PUT /api/v1/me/prefs { dj }), so it follows them
 * between devices; the device that plays applies them.
 */
export type DjCrossfade = 'off' | 'fixed' | 'auto';

export const DJ_LENGTH_MIN_SEC = 2;
export const DJ_LENGTH_MAX_SEC = 12;

export const djSimpleSettingsSchema = z.object({
  crossfade: z.enum(['off', 'fixed', 'auto']),
  /** seconds, for Fixed */
  lengthSec: z.number().int().min(DJ_LENGTH_MIN_SEC).max(DJ_LENGTH_MAX_SEC),
  beatAligned: z.boolean(),
  /** never fade between consecutive tracks of one album */
  gaplessAlbums: z.boolean(),
}).strict();
export type DjSimpleSettings = z.infer<typeof djSimpleSettingsSchema>;

export const DJ_DEFAULTS: DjSimpleSettings = { crossfade: 'off', lengthSec: 6, beatAligned: false, gaplessAlbums: true };

/** This browser's copy of the person's Simple mode (read before the server answers). */
export const DJ_SETTINGS_STORAGE_KEY = 'tagave-dj';

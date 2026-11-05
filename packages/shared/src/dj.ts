/**
 * The DJ module (vault "tagave - DJ Module"): what the player needs to mix
 * one track into the next, and each person's Simple mode settings.
 *
 * GET /api/v1/me/dj/tracks?ids=a,b,c answers DjTrackInfo[] (nulls where a
 * track is not analysed yet; 404 while the module is off). The analysis is
 * made at scan time by the worker.
 */

export interface DjTrackInfo {
  localTrackId: string;
  /** beats a minute, or null before the analysis */
  bpm: number | null;
  /** 0 to 1 */
  bpmConfidence: number | null;
  /** where the beat grid starts */
  firstBeatMs: number | null;
  /** where the sound starts and ends (the silence trimmed off) */
  trimStartMs: number | null;
  trimEndMs: number | null;
  durationMs: number;
  /** the same for every track of one album */
  albumKey: string | null;
  trackNo: number | null;
  discNo: number | null;
}

export type DjCrossfade = 'off' | 'fixed' | 'auto';

/** Settings › Modules › DJ, per person (kept in the browser that plays). */
export interface DjSettings {
  crossfade: DjCrossfade;
  /** seconds, for Fixed */
  lengthSec: number;
  beatAligned: boolean;
  /** never fade between consecutive tracks of one album */
  gaplessAlbums: boolean;
}

export const DJ_LENGTH_MIN_SEC = 2;
export const DJ_LENGTH_MAX_SEC = 12;

export const DJ_DEFAULTS: DjSettings = { crossfade: 'off', lengthSec: 6, beatAligned: false, gaplessAlbums: true };

export const DJ_SETTINGS_STORAGE_KEY = 'tagave-dj';

/**
 * Whole album in one file (0078 album_splits). An album that is one long
 * FLAC with no cue sheet, matched to a release of several tracks, is split
 * into one FLAC per track: the file worker (files.split) finds the cut
 * points, the owner checks them, the worker writes the tracks and moves the
 * source into the music folder's trash (Restore puts it back).
 */

/** The gap kind gaps.recompute writes for such an album (Library care › Attention). */
export const ONE_FILE_ALBUM_GAP = 'one_file_album';

/** The file may differ from the release's total by this much, or 1 % of it, whichever is more. */
export const ONE_FILE_TOLERANCE_MS = 20_000;
export const ONE_FILE_TOLERANCE_SHARE = 0.01;

/** How far a cut may move from the point the release's lengths give, each way. */
export const SPLIT_SEARCH_MS = 6_000;

/** A written track's length may differ from the plan by at most this much. */
export const SPLIT_LENGTH_SLACK_MS = 100;

/**
 * The detection rule: one audio file, more than one release track, every
 * track length known, and the file within max(20 s, 1 %) of their sum.
 */
export function looksLikeWholeAlbum(fileMs: number | null | undefined, lengthsMs: ReadonlyArray<number | null | undefined>): boolean {
  if (fileMs == null || !Number.isFinite(fileMs) || fileMs <= 0) return false;
  if (lengthsMs.length < 2) return false;
  let sum = 0;
  for (const l of lengthsMs) {
    if (l == null || !Number.isFinite(l) || l <= 0) return false;
    sum += l;
  }
  return Math.abs(fileMs - sum) <= Math.max(ONE_FILE_TOLERANCE_MS, sum * ONE_FILE_TOLERANCE_SHARE);
}

export type CutConfidence = 'high' | 'medium' | 'low';

/** One track of a split, as the owner checks it. Samples count from the source's first. */
export interface SplitTrackPlan {
  /** 1-based, in release order */
  n: number;
  disc: number;
  position: number;
  title: string;
  /** first sample (inclusive) and end sample (exclusive) */
  startSample: number;
  endSample: number;
  /** the file name it is written as, in the source's folder */
  fileName: string;
  /** its start cut (null for the first track): moved this far from the release's lengths, and how sure */
  shiftMs: number | null;
  confidence: CutConfidence | null;
}

export interface SplitPlan {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  totalSamples: number;
  tracks: SplitTrackPlan[];
}

export type AlbumSplitState = 'analyzing' | 'ready' | 'splitting' | 'done' | 'failed';

/** GET /libraries/:libraryId/albums/:albumId/split */
export interface AlbumSplitView {
  /** the latest split of the album, if any */
  split: {
    id: string;
    state: AlbumSplitState;
    plan: SplitPlan | null;
    outputs: string[] | null;
    error: string | null;
    createdAt: string;
    finishedAt: string | null;
  } | null;
  /** the album is one file that fits the rule */
  eligible: boolean;
  /** the music folder can be written (the setting and the worker's check) */
  writable: boolean;
  /** the source's track, for Play around cut (the stream route) */
  localTrackId: string | null;
}

/** files.split job data */
export interface FilesSplitJobData {
  splitId: string;
  action: 'analyze' | 'split';
}

/** Milliseconds of a sample position. */
export function sampleMs(sample: number, sampleRate: number): number {
  return (sample * 1000) / sampleRate;
}

/** "3:07", "1:02:05" from milliseconds. */
export function clockOf(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** "+0.8 s", "−1.2 s", "0.0 s". */
export function shiftLabel(ms: number): string {
  const s = Math.round(ms / 100) / 10;
  if (s === 0) return '0.0 s';
  return `${s > 0 ? '+' : '−'}${Math.abs(s).toFixed(1)} s`;
}

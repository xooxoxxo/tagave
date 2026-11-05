/**
 * The DJ module's Simple mode, as pure functions (vault "tagave - DJ
 * Module"): where one track fades into the next, how long, from where the
 * next one comes in, at what tempo, and when it eases back to its own. The
 * engine (engine.ts) does what these say; nothing here touches audio.
 *
 *   Off          today's gapless handoff
 *   Fixed        the last L seconds (2–12) under the next track's start
 *   Auto         ends where the outgoing sound ends (trimEnd), the next comes
 *                in where its sound starts (trimStart), L ≈ 16 beats (4–10 s)
 *   Beat-aligned the fade starts on an outgoing beat, the next comes in on
 *                one of its own; within ±8 % of tempo it comes in at the
 *                outgoing tempo and eases back to its own over 8 bars
 *   Gapless      consecutive tracks of one album never fade
 *
 * Missing analysis never stops a transition: Auto falls back to Fixed 6 s,
 * Beat-aligned is left out, and an unknown length is a plain handoff.
 */
import type { DjSimpleSettings, DjTrackInfo } from '@tagave/shared';
import { DJ_DEFAULTS, DJ_LENGTH_MAX_SEC, DJ_LENGTH_MIN_SEC } from '@tagave/shared';

/** What planning knows of a track: the analysis where there is one, else the queue's own facts. */
export interface DjTrackFacts {
  localTrackId: string;
  durationSec: number | null;
  bpm: number | null;
  bpmConfidence: number | null;
  firstBeatSec: number | null;
  trimStartSec: number | null;
  trimEndSec: number | null;
  albumKey: string | null;
  discNo: number | null;
  trackNo: number | null;
}

export interface QueueFacts {
  localTrackId: string;
  albumId?: string | null;
  discNo?: number | null;
  trackNo?: number | null;
  durationMs?: number | null;
}

const sec = (ms: number | null | undefined) => (ms == null || !Number.isFinite(ms) ? null : ms / 1000);

/** The queue's facts, with the analysis over them where it has a value. */
export function trackFacts(q: QueueFacts, info: DjTrackInfo | null | undefined, elementDurationSec?: number | null): DjTrackFacts {
  const tagged = sec(info?.durationMs ?? q.durationMs ?? null);
  const duration = elementDurationSec != null && Number.isFinite(elementDurationSec) && elementDurationSec > 0 ? elementDurationSec : tagged;
  return {
    localTrackId: q.localTrackId,
    durationSec: duration != null && duration > 0 ? duration : null,
    bpm: info?.bpm ?? null,
    bpmConfidence: info?.bpmConfidence ?? null,
    firstBeatSec: sec(info?.firstBeatMs),
    trimStartSec: sec(info?.trimStartMs),
    trimEndSec: sec(info?.trimEndMs),
    albumKey: info?.albumKey ?? q.albumId ?? null,
    discNo: info?.discNo ?? q.discNo ?? null,
    trackNo: info?.trackNo ?? q.trackNo ?? null,
  };
}

/** The settings as read from storage: anything unknown is the default. */
export function parseDjSettings(raw: unknown): DjSimpleSettings {
  const o = raw && typeof raw === 'object' ? raw as Partial<Record<keyof DjSimpleSettings, unknown>> : {};
  const crossfade = o.crossfade === 'fixed' || o.crossfade === 'auto' || o.crossfade === 'off' ? o.crossfade : DJ_DEFAULTS.crossfade;
  const len = typeof o.lengthSec === 'number' && Number.isFinite(o.lengthSec) ? Math.round(o.lengthSec) : DJ_DEFAULTS.lengthSec;
  return {
    crossfade,
    lengthSec: clamp(len, DJ_LENGTH_MIN_SEC, DJ_LENGTH_MAX_SEC),
    beatAligned: typeof o.beatAligned === 'boolean' ? o.beatAligned : DJ_DEFAULTS.beatAligned,
    gaplessAlbums: typeof o.gaplessAlbums === 'boolean' ? o.gaplessAlbums : DJ_DEFAULTS.gaplessAlbums,
  };
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The tempo window inside which the incoming track is matched to the outgoing one. */
export const TEMPO_WINDOW = 0.08;
/** Auto's length: 16 beats, within these seconds. */
export const AUTO_BEATS = 16;
export const AUTO_MIN_SEC = 4;
export const AUTO_MAX_SEC = 10;
/** Auto without the analysis, and any fade whose length is not known. */
export const FALLBACK_SEC = 6;
/** The tempo eases back over 8 bars of 4 beats. */
export const RAMP_BEATS = 32;
/** A bpm the analysis is trusted with. */
export const MIN_CONFIDENCE = 0.5;
/** The next track loads at least this long before its fade begins (plus the fade's own length). */
export const PRELOAD_LEAD_SEC = 30;

/** A beat grid planning can use: a plausible tempo, a first beat, enough confidence. */
export function beatGrid(t: DjTrackFacts): { firstBeat: number; period: number } | null {
  if (t.bpm == null || !Number.isFinite(t.bpm) || t.bpm < 40 || t.bpm > 250) return null;
  if (t.firstBeatSec == null || !Number.isFinite(t.firstBeatSec) || t.firstBeatSec < 0) return null;
  if (t.bpmConfidence != null && t.bpmConfidence < MIN_CONFIDENCE) return null;
  return { firstBeat: t.firstBeatSec, period: 60 / t.bpm };
}

/** `t` moved onto the grid: the beat at or after it (dir 1), at or before it (-1), or the nearest (0). */
export function snapToBeat(t: number, firstBeat: number, period: number, dir: -1 | 0 | 1): number {
  const k = (t - firstBeat) / period;
  const n = dir > 0 ? Math.ceil(k - 1e-6) : dir < 0 ? Math.floor(k + 1e-6) : Math.round(k);
  return firstBeat + n * period;
}

/** The next track is the following one of the same album (the next track number, or the first of the next disc). */
export function isAlbumSequence(out: DjTrackFacts, inc: DjTrackFacts): boolean {
  if (!out.albumKey || out.albumKey !== inc.albumKey) return false;
  if (out.trackNo == null || inc.trackNo == null) return false;
  const d0 = out.discNo ?? 1;
  const d1 = inc.discNo ?? 1;
  return (d1 === d0 && inc.trackNo === out.trackNo + 1) || (d1 === d0 + 1 && inc.trackNo === 1);
}

export type DjTransition =
  | { kind: 'cut'; reason: 'off' | 'gapless' | 'short' | 'unknown' }
  | {
    kind: 'fade';
    /** where the fade begins in the outgoing track (seconds) */
    startSec: number;
    /** how long it lasts, in outgoing-track seconds */
    lengthSec: number;
    /** where the incoming track starts (seconds into it) */
    inAtSec: number;
    /** both start on beats */
    beatAligned: boolean;
    /** the incoming track's playbackRate during the fade (1: its own tempo) */
    rateIn: number;
    /** after the fade, the incoming track eases back to rate 1 over this many of its own seconds (0: none) */
    rampSec: number;
    /** Auto without the analysis: Fixed 6 s instead */
    fallback: boolean;
  };

/** Where `out` fades into `inc`, or a plain handoff. */
export function planTransition(out: DjTrackFacts, inc: DjTrackFacts, settings: DjSimpleSettings): DjTransition {
  const s = parseDjSettings(settings);
  if (s.crossfade === 'off') return { kind: 'cut', reason: 'off' };
  if (s.gaplessAlbums && isAlbumSequence(out, inc)) return { kind: 'cut', reason: 'gapless' };
  const outDur = out.durationSec;
  if (outDur == null) return { kind: 'cut', reason: 'unknown' };

  let fallback = false;
  let end = outDur;
  let length: number;
  let inAt = 0;
  const outGrid = beatGrid(out);
  if (s.crossfade === 'auto') {
    if (out.trimEndSec != null && out.trimEndSec > 0) {
      end = Math.min(out.trimEndSec, outDur);
      length = outGrid ? clamp(AUTO_BEATS * outGrid.period, AUTO_MIN_SEC, AUTO_MAX_SEC) : FALLBACK_SEC;
      inAt = Math.max(0, inc.trimStartSec ?? 0);
    } else {
      fallback = true;
      length = FALLBACK_SEC;
    }
  } else {
    length = clamp(s.lengthSec, DJ_LENGTH_MIN_SEC, DJ_LENGTH_MAX_SEC);
  }

  let start = end - length;
  let beatAligned = false;
  let rateIn = 1;
  let rampSec = 0;
  const inGrid = beatGrid(inc);
  if (s.beatAligned && !fallback && outGrid && inGrid) {
    const p = outGrid.period;
    const L = Math.max(p, Math.round(length / p) * p);
    start = snapToBeat(end - L, outGrid.firstBeat, p, -1);
    length = end - start;
    inAt = Math.max(0, snapToBeat(inAt, inGrid.firstBeat, inGrid.period, 1));
    beatAligned = true;
    const ratio = inc.bpm! > 0 ? out.bpm! / inc.bpm! : 1;
    if (Math.abs(ratio - 1) <= TEMPO_WINDOW && Math.abs(ratio - 1) > 1e-4) {
      rateIn = ratio;
      rampSec = RAMP_BEATS * inGrid.period;
    }
  }

  // a short track: the fade takes at most half of either one
  const maxOut = outDur / 2;
  const incDur = inc.durationSec;
  const maxIn = incDur != null ? (incDur / 2 - inAt) / rateIn : Number.POSITIVE_INFINITY;
  const fit = Math.min(maxOut, maxIn);
  if (length > fit || start < 0) {
    length = Math.min(length, fit, end);
    start = end - length;
    if (beatAligned) { beatAligned = false; rateIn = 1; rampSec = 0; }
  }
  if (!(length >= 1)) return { kind: 'cut', reason: 'short' };
  return { kind: 'fade', startSec: start, lengthSec: length, inAtSec: inAt, beatAligned, rateIn, rampSec, fallback };
}

/** When the next track starts loading (seconds into the outgoing one). */
export function preloadAtSec(t: DjTransition, outDurationSec: number): number {
  if (t.kind === 'fade') return Math.max(0, t.startSec - t.lengthSec - PRELOAD_LEAD_SEC);
  return Math.max(0, outDurationSec - PRELOAD_LEAD_SEC);
}

/** An equal-power curve of n points: sin rising, cos falling, so the sum of powers stays 1. */
export function equalPower(n: number, rising: boolean): Float32Array {
  const a = new Float32Array(Math.max(2, n));
  for (let i = 0; i < a.length; i++) {
    const x = i / (a.length - 1);
    a[i] = rising ? Math.sin((x * Math.PI) / 2) : Math.cos((x * Math.PI) / 2);
  }
  return a;
}

/** The part of a fade from `progress` (0..1) on: a fade that starts late picks up where it would be. */
export function equalPowerFrom(n: number, rising: boolean, progress: number): Float32Array {
  const p0 = clamp(progress, 0, 1);
  const a = new Float32Array(Math.max(2, n));
  for (let i = 0; i < a.length; i++) {
    const x = p0 + (1 - p0) * (i / (a.length - 1));
    a[i] = rising ? Math.sin((x * Math.PI) / 2) : Math.cos((x * Math.PI) / 2);
  }
  return a;
}

/** Where the incoming track should be, seconds into it, when the outgoing one is at `posOut`. */
export function expectedIncoming(posOut: number, startSec: number, inAtSec: number, rateIn: number, rateOut = 1): number {
  return inAtSec + ((posOut - startSec) * rateIn) / (rateOut || 1);
}

/**
 * The incoming element's rate that pulls `errSec` (how far ahead it is) back
 * over about `tauSec`, at most `maxSlew` away from `baseRate`; a few ms are
 * left alone.
 */
export function lockRate(errSec: number, baseRate: number, maxSlew: number, tauSec = 0.25, deadbandSec = 0.002): number {
  if (!Number.isFinite(errSec) || Math.abs(errSec) <= deadbandSec) return baseRate;
  return baseRate - clamp(errSec / tauSec, -maxSlew, maxSlew);
}

/** The rate along the ease back to the track's own tempo: progress 0 → fromRate, 1 → 1, eased at both ends. */
export function rampRate(fromRate: number, progress: number): number {
  const p = clamp(progress, 0, 1);
  return fromRate + (1 - fromRate) * (1 - Math.cos(Math.PI * p)) / 2;
}

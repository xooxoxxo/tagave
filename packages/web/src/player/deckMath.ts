/**
 * The DJ view's rules (Advanced mode, vault "tagave - DJ Module"), as pure
 * functions: the crossfader, which deck is heard, Pitch and Sync, the cue
 * point, the beat phase, and when a deck's track counts as played. The deck
 * engine (djDecks.ts) does what these say; nothing here touches audio.
 */
import { beatGrid, clamp, snapToBeat, type DjTrackFacts } from './djPlan';

/** Pitch and Sync stay within ±8 % of the track's own tempo. */
export const PITCH_RANGE = 0.08;

/** The crossfader at x (0: deck A only, 1: deck B only), equal power: cos² + sin² = 1. */
export function crossfadeGains(x: number): [number, number] {
  const v = clamp(Number.isFinite(x) ? x : 0, 0, 1);
  return [Math.cos((v * Math.PI) / 2), Math.sin((v * Math.PI) / 2)];
}

/**
 * The deck the crossfader favours: the one heard (the queue, Now playing,
 * the play events and the Media Session follow it). Dead centre keeps the
 * one heard before, so a crossfader at rest there does not flip.
 */
export function heardDeck(x: number, before: 0 | 1): 0 | 1 {
  if (x < 0.5) return 0;
  if (x > 0.5) return 1;
  return before;
}

/** A rate inside the pitch range. */
export const clampRate = (rate: number): number => clamp(Number.isFinite(rate) && rate > 0 ? rate : 1, 1 - PITCH_RANGE, 1 + PITCH_RANGE);

/** The pitch as a percentage of the track's own tempo (+2.4). */
export const pitchPercent = (rate: number): number => Math.round((rate - 1) * 1000) / 10;

/** "+2.4 %", "0.0 %", "−1.0 %". */
export function pitchText(rate: number): string {
  const p = pitchPercent(rate);
  if (p === 0) return '0.0 %';
  return `${p > 0 ? '+' : '−'}${Math.abs(p).toFixed(1)} %`;
}

/** The tempo heard: the track's BPM times its rate. */
export function effectiveBpm(bpm: number | null | undefined, rate: number): number | null {
  if (bpm == null || !Number.isFinite(bpm) || bpm <= 0) return null;
  return bpm * rate;
}

/**
 * Sync: the rate that gives this deck the other deck's effective tempo,
 * within the pitch range; null when either tempo is unknown.
 */
export function syncRate(bpm: number | null | undefined, otherBpm: number | null | undefined, otherRate: number): number | null {
  if (bpm == null || otherBpm == null || !(bpm > 0) || !(otherBpm > 0)) return null;
  return clampRate((otherBpm * otherRate) / bpm);
}

/** Where a beat phase is: 0 on a beat, up to 1 just before the next. */
export function beatPhase(posSec: number, firstBeat: number, period: number): number {
  const k = (posSec - firstBeat) / period;
  return k - Math.floor(k);
}

/**
 * How far this deck is ahead of the other's beat, in this deck's own track
 * seconds, within half a beat either way (both on a beat: 0).
 */
export function phaseError(pos: number, grid: { firstBeat: number; period: number }, otherPos: number, otherGrid: { firstBeat: number; period: number }): number {
  let d = beatPhase(pos, grid.firstBeat, grid.period) - beatPhase(otherPos, otherGrid.firstBeat, otherGrid.period);
  if (d >= 0.5) d -= 1;
  if (d < -0.5) d += 1;
  return d * grid.period;
}

/**
 * Where this deck should be, near `pos`, to sit on the other deck's beat:
 * `pos` moved by its phase error (never before 0).
 */
export function alignedPosition(pos: number, grid: { firstBeat: number; period: number }, otherPos: number, otherGrid: { firstBeat: number; period: number }): number {
  const target = pos - phaseError(pos, grid, otherPos, otherGrid);
  return target < 0 ? target + grid.period : target;
}

/** Cue: the first beat at or after where the sound starts; without a grid, where the sound starts; else 0. */
export function cuePoint(t: Pick<DjTrackFacts, 'bpm' | 'bpmConfidence' | 'firstBeatSec' | 'trimStartSec'> & Partial<DjTrackFacts>): number {
  const start = Math.max(0, t.trimStartSec ?? 0);
  const grid = beatGrid({ localTrackId: '', durationSec: null, albumKey: null, discNo: null, trackNo: null, trimEndSec: null, ...t });
  if (!grid) return start;
  return Math.max(0, snapToBeat(start, grid.firstBeat, grid.period, 1));
}

/** The downbeats (every 4th beat from the first) as fractions of the track, for the waveform's ticks. */
export function downbeats(t: { bpm: number | null; firstBeatSec: number | null; bpmConfidence?: number | null }, durationSec: number | null, max = 512): number[] {
  if (!durationSec || !(durationSec > 0) || t.bpm == null || !(t.bpm > 0) || t.firstBeatSec == null || t.firstBeatSec < 0) return [];
  const bar = (4 * 60) / t.bpm;
  const out: number[] = [];
  for (let s = t.firstBeatSec; s < durationSec && out.length < max; s += bar) out.push(s / durationSec);
  return out;
}

/**
 * A track a deck let go of (another one loaded over it, the view left, the
 * queue stopped): what its play event says. Its heard time is only the time
 * the deck played while it was the deck heard; the server counts the play
 * as heard at half the track or four minutes, and scrobbles it when the
 * track is longer than 30 s (core › scrobble/rules.ts), as for every play.
 * Null: it was never heard, nothing is sent.
 */
export function releaseEvent(t: { started: boolean; heardSec: number; reachedEnd: boolean; durationSec: number | null }): 'completed' | 'skipped' | null {
  if (!t.started) return null;
  if (t.reachedEnd) return 'completed';
  if (t.durationSec && t.durationSec > 0 && t.heardSec >= t.durationSec / 2) return 'completed';
  return 'skipped';
}

/** "1:23" for the deck's clock. */
export function deckClock(sec: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

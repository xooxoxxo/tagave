/**
 * The player's rules, with no audio element and no React: which track plays
 * next, what Previous does, which stream format this browser gets, how a
 * transcoded stream is seeked, how a failed stream is handled and when Space
 * belongs to the player. engine.ts applies them; logic.test.ts pins them.
 */
import { PLAYER_QUALITY_STORAGE_KEY, STREAM_BITRATES, type PlayerQuality, type PlayerQueueTrack, type PlayerQueueView, type StreamFormat } from '@tagave/shared';

type Playable = Pick<PlayerQueueTrack, 'available'>;

/** The first playable track at or after `from`, or -1. */
export function firstPlayableFrom(tracks: readonly Playable[], from: number): number {
  for (let i = Math.max(0, from); i < tracks.length; i++) if (tracks[i]!.available) return i;
  return -1;
}

/** The next playable track after `index`, or -1 at the end of the queue. */
export function nextPlayable(tracks: readonly Playable[], index: number): number {
  return firstPlayableFrom(tracks, index + 1);
}

/** The previous playable track before `index`, or -1 at the start. */
export function previousPlayable(tracks: readonly Playable[], index: number): number {
  for (let i = Math.min(index, tracks.length) - 1; i >= 0; i--) if (tracks[i]!.available) return i;
  return -1;
}

/** Previous restarts the track once it is more than 3 s in, otherwise goes back one playable track (restarting the first). */
export function previousAction(tracks: readonly Playable[], index: number, positionSec: number): { kind: 'restart' } | { kind: 'go'; index: number } {
  if (positionSec > 3) return { kind: 'restart' };
  const prev = previousPlayable(tracks, index);
  return prev < 0 ? { kind: 'restart' } : { kind: 'go', index: prev };
}

/**
 * Where "Play" (no track) or "Play from here" (a track id) starts: that
 * track, or the first playable one after it. -1 when nothing from there on
 * can be played.
 */
export function startIndex(tracks: readonly PlayerQueueTrack[], startTrackId?: string | null): number {
  const at = startTrackId ? tracks.findIndex((t) => t.localTrackId === startTrackId) : 0;
  return firstPlayableFrom(tracks, at < 0 ? 0 : at);
}

/** The queue's tracks in disc, then track order (the API already sends them so; this keeps it true). */
export function orderQueue(tracks: readonly PlayerQueueTrack[]): PlayerQueueTrack[] {
  return tracks
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (a.t.discNo - b.t.discNo) || ((a.t.trackNo ?? Number.MAX_SAFE_INTEGER) - (b.t.trackNo ?? Number.MAX_SAFE_INTEGER)) || (a.i - b.i))
    .map(({ t }) => t);
}

const REASON_TEXT: Record<string, string> = {
  not_scanned: 'These tracks are not on the player yet.',
  no_file: 'The files for these tracks are missing or could not be read.',
  cue: 'Tracks inside a CUE image cannot be played yet.',
};

/** The plain sentence shown when nothing in the queue can be played. */
export function nothingPlayableMessage(view: Pick<PlayerQueueView, 'scanRequested' | 'tracks'>, from = 0): string {
  if (view.scanRequested) return 'None of these tracks are on the player yet; tagave asked it to scan. Try again in a minute.';
  const reason = view.tracks.slice(Math.max(0, from)).find((t) => !t.available && t.reason)?.reason
    ?? view.tracks.find((t) => !t.available && t.reason)?.reason;
  if (view.tracks.length === 0) return 'This album has no tracks to play.';
  return (reason && REASON_TEXT[reason]) || 'None of these tracks can be played right now.';
}

// ---- formats ----

/** HTMLMediaElement.canPlayType, or a stand-in for it. */
export type CanPlay = (type: string) => '' | 'maybe' | 'probably' | string;

const can = (canPlay: CanPlay, type: string) => {
  const answer = canPlay(type);
  return answer === 'probably' || answer === 'maybe';
};

/** The best transcode this browser plays: opus, then AAC, then MP3 (which every browser plays). */
export function transcodeFormat(canPlay: CanPlay): Exclude<StreamFormat, 'original'> {
  if (can(canPlay, 'audio/ogg; codecs="opus"')) return 'opus';
  if (can(canPlay, 'audio/aac') || can(canPlay, 'audio/mp4; codecs="mp4a.40.2"')) return 'aac';
  return 'mp3';
}

/** The format to ask for: an explicit choice wins; auto plays the original when the browser can, else transcodes. */
export function chooseFormat(quality: PlayerQuality, mime: string | null, canPlay: CanPlay): StreamFormat {
  if (quality.format !== 'auto') return quality.format;
  if (mime && can(canPlay, mime)) return 'original';
  return transcodeFormat(canPlay);
}

export const DEFAULT_QUALITY: PlayerQuality = { format: 'auto', bitrate: 192 };

/** What is stored, keeping only valid values. */
export function parseQuality(raw: string | null | undefined): PlayerQuality {
  let stored: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === 'object') stored = parsed as Record<string, unknown>;
  } catch { /* corrupt: defaults */ }
  const format = stored['format'];
  const bitrate = stored['bitrate'];
  return {
    format: format === 'original' || format === 'opus' || format === 'aac' || format === 'mp3' ? format : 'auto',
    bitrate: typeof bitrate === 'number' && (STREAM_BITRATES as readonly number[]).includes(bitrate) ? bitrate : DEFAULT_QUALITY.bitrate,
  };
}

export function readQuality(): PlayerQuality {
  try {
    return parseQuality(globalThis.localStorage?.getItem(PLAYER_QUALITY_STORAGE_KEY));
  } catch {
    return DEFAULT_QUALITY;
  }
}

/** The stream URL for one track (same origin, the session cookie rides along). */
export function streamUrl(localTrackId: string, format: StreamFormat, bitrate: number, offsetSec = 0): string {
  const q = new URLSearchParams({ format });
  if (format !== 'original') q.set('maxBitRate', String(bitrate));
  const offset = Math.max(0, Math.floor(offsetSec));
  if (format !== 'original' && offset > 0) q.set('offset', String(offset));
  return `/api/v1/player/stream/${encodeURIComponent(localTrackId)}?${q.toString()}`;
}

// ---- seeking ----

/**
 * A seek: the original file seeks natively (HTTP ranges); a transcode cannot,
 * so it is reloaded from a whole second and that second becomes the base the
 * element's own clock counts from.
 */
export function seekPlan(format: StreamFormat, targetSec: number, durationSec: number | null): { kind: 'native'; time: number } | { kind: 'reload'; offset: number } {
  const max = durationSec && Number.isFinite(durationSec) ? Math.max(0, durationSec - 0.25) : Number.POSITIVE_INFINITY;
  const t = Math.min(Math.max(0, targetSec), max);
  return format === 'original' ? { kind: 'native', time: t } : { kind: 'reload', offset: Math.floor(t) };
}

/** The position shown: the reload offset plus the element's own clock. */
export function shownPosition(baseOffsetSec: number, elementTimeSec: number): number {
  return baseOffsetSec + (Number.isFinite(elementTimeSec) ? elementTimeSec : 0);
}

/** The length shown: the tag's length for a transcode (the element only knows the remainder), the element's for the original. */
export function shownDuration(format: StreamFormat, trackDurationMs: number | null, elementDurationSec: number): number | null {
  const tagged = trackDurationMs != null && trackDurationMs > 0 ? trackDurationMs / 1000 : null;
  if (format !== 'original') return tagged;
  return Number.isFinite(elementDurationSec) && elementDurationSec > 0 ? elementDurationSec : tagged;
}

/** Heard time for one timeupdate: a small forward step counts, a jump (a seek) or a step back does not. */
export function heardDelta(previousSec: number | null, nowSec: number): number {
  if (previousSec == null) return 0;
  const d = nowSec - previousSec;
  return d > 0 && d < 2 ? d : 0;
}

/** Preload the next track once the current one is within 20 s of its end (or at once when it is shorter than that). */
export function shouldPreload(positionSec: number, durationSec: number | null): boolean {
  if (durationSec == null || !Number.isFinite(durationSec) || durationSec <= 0) return false;
  return durationSec <= 20 || durationSec - positionSec <= 20;
}

/** "1:23", or "1:02:03" past an hour. */
export function clock(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

// ---- failures ----

/**
 * What to do when the element gives up on a stream. `probe` is the status a
 * one-byte request to the same URL got (null: it did not reach tagave).
 *  - skip      409: the file is not on the player yet; mark it and go on
 *  - fallback  the original reached the browser but would not decode; try a transcode once
 *  - busy      429: too many streams at once for this user
 *  - network   tagave did not answer
 *  - failed    anything else
 */
export type StreamFailure = 'skip' | 'fallback' | 'busy' | 'network' | 'failed';

export function classifyFailure({ probe, format, triedFallback }: { probe: number | null; format: StreamFormat; triedFallback: boolean }): StreamFailure {
  if (probe == null) return 'network';
  if (probe === 409 || probe === 404) return 'skip';
  if (probe === 429) return 'busy';
  if (probe >= 200 && probe < 300 && format === 'original' && !triedFallback) return 'fallback';
  return 'failed';
}

export const FAILURE_TEXT: Record<Exclude<StreamFailure, 'skip' | 'fallback'>, string> = {
  busy: 'Too many tracks are playing on your account right now. Stop one, then try again.',
  network: 'tagave did not answer. Check the connection, then try again.',
  failed: 'This track could not be played.',
};

// ---- keyboard ----

/** The bits of an element the Space guard reads (a real Element fits). */
export interface KeyTarget {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

/** Controls Space already activates or types into; the player leaves those alone. */
const SPACE_OWNERS = 'button, a[href], summary, select, textarea, [contenteditable=""], [contenteditable="true"], [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="tab"], [role="option"], [role="combobox"], [role="textbox"]';

/**
 * Space toggles play and pause while a queue exists, unless focus is in a
 * field or on a control that Space presses. A range input (the seek bar,
 * the volume) does nothing with Space, so it is left to the player.
 */
export function spaceTogglesPlayback(
  e: { key: string; code?: string; repeat?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; defaultPrevented?: boolean },
  target: KeyTarget | null | undefined,
  hasQueue: boolean,
): boolean {
  if (!hasQueue) return false;
  if (e.key !== ' ' && e.code !== 'Space') return false;
  if (e.repeat || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented) return false;
  if (!target) return true;
  const tag = (target.tagName ?? '').toUpperCase();
  if (tag === 'INPUT') return (target.type ?? '').toLowerCase() === 'range';
  if (tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'SUMMARY') return false;
  if (target.isContentEditable) return false;
  if (typeof target.closest === 'function' && target.closest(SPACE_OWNERS)) return false;
  return true;
}

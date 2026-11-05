/**
 * The web player: two plain <audio> elements kept outside React (no Web
 * Audio graph: background audio in an iOS home-screen app breaks with one;
 * only the opt-in equalizer glow reads them through an analyser, from a copy
 * of the sound where the browser can make one, and never on iOS:
 * adaptive/levels.ts),
 * a small zustand store the bar and the album page read, the play events
 * and the Media Session. The rules it applies live in logic.ts.
 *
 * One element plays; the other loads the next playable track once the
 * current one is within 30 s of its end. In the last half second a timer
 * starts the next one just before the current one ends (near-gapless where
 * the browser allows; a background tab's slowed timers fall back to the
 * `ended` swap). Nothing here waits on a frame or on the page being shown:
 * with the phone locked, `ended` starts the next track, and where the
 * browser will not start the waiting element without a tap (iOS), the next
 * track loads into the element that just played.
 *
 * The queue holds tracks from any albums: the album or playlist that was
 * started ("context") and what the person added by hand with Play next or
 * Add to queue ("queued"), which plays first. It is kept on the server per
 * person (PUT /me/player/queue), so it follows them to another device. Any
 * device may change it; the device that plays picks the change up and plays
 * on. Only a play action (Play, Play from here) on another device moves
 * playback there, and this one stops at once (player/devices.ts hears it on
 * the person's event stream). While another device plays, this one shows it
 * and its keys (play, pause, next, previous, seek, volume, a queue row) go
 * there as commands; "This device" or Play once that device is gone plays
 * here again.
 *
 * Casting (player/cast.ts) comes in two shapes:
 *   - the elements play to the device (AirPlay, the Remote Playback API on
 *     Android): one element only (no preloaded second one to hand over to),
 *     loading signed links (castLinks.ts) the device can fetch itself;
 *   - a receiver plays instead (the Google Cast SDK on a desktop): a
 *     RemoteSink takes every load, play, pause, seek and volume, and its
 *     state and time come back through the sink* functions below.
 */
import { create } from 'zustand';
import type { DjTrackInfo, PlayEventKind, PlayerCommandAction, PlayerQueueView, PlayerScanStatus, QueueContext, QueueOrigin, QueueStampView, QueueStateView, QueueTrack, StreamFormat } from '@tagave/shared';
import { api, type ApiError } from '../services/api';
import {
  FAILURE_TEXT, chooseFormat, classifyFailure, clearQueued, handoffDelayMs, heardDelta, insertQueued, moveUpcoming, nextPlayable, nothingPlayableMessage, queueOrder,
  previousAction, removeUpcoming, seekPlan, shouldPreload, shownDuration, shownPosition, shuffleTracks, startContext, startIndex, streamUrl, transcodeFormat, type CanPlay,
} from './logic';
import { getPlayerQuality } from './quality';
import { cachedCastLink, castSrc, fetchCastLink } from './castLinks';
import { isAppleMobile } from './platform';
import { deviceId, randomId } from './deviceIdentity';
import { allRouted, elementGain, existingContext, onContextTrouble, resetGains, routeElements, setGainNow, startContext as resumeGraph } from './audioGraph';
import { djWanted, getDjSettings, subscribeDj } from './djSettings';
import { equalPowerFrom, expectedIncoming, lockRate, planTransition, preloadAtSec, rampRate, trackFacts, type DjTransition } from './djPlan';

export { deviceId } from './deviceIdentity';

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'buffering' | 'error';

/** One entry of the queue: a track with its album, where it came from, and an id of its own (a track may be queued twice). */
export interface QueueEntry extends QueueTrack {
  uid: string;
  origin: QueueOrigin;
}

export interface PlayerQueue {
  /** the album or playlist that was started, if any */
  context: QueueContext | null;
  /** in play order (availability updated as streams answer) */
  tracks: QueueEntry[];
  /** the album's tracks were not all on the player server, so tagave asked it to scan */
  scanRequested: boolean;
  scan?: PlayerScanStatus | null;
}

export interface PlayerState {
  queue: PlayerQueue | null;
  queueId: string | null;
  index: number;
  status: PlayerStatus;
  /** the plain sentence shown with the error state */
  message: string | null;
  /** what Retry does: reload this track's stream, or ask for the album's queue again */
  retry: 'stream' | 'queue' | null;
  /** an album whose queue is being fetched (its Play button shows that) */
  loadingAlbumId: string | null;
  /** seconds into the current track, and its length when known */
  position: number;
  duration: number | null;
  volume: number;
  /** playback was handed here and the browser would not start it without a tap */
  needsTap: boolean;
  /** another of the person's devices plays: this one shows it, and its keys control it */
  remoteDeviceId: string | null;
  /** the DJ module mixes the last track into this one now (the bar's Mix chip): the fade's length */
  mix: { lengthMs: number; at: number } | null;
}

const initial: PlayerState = { queue: null, queueId: null, index: -1, status: 'idle', message: null, retry: null, loadingAlbumId: null, position: 0, duration: null, volume: 1, needsTap: false, remoteDeviceId: null, mix: null };

export const usePlayerStore = create<PlayerState>()(() => ({ ...initial }));
const get = () => usePlayerStore.getState();
const set = (patch: Partial<PlayerState>) => usePlayerStore.setState(patch);

/** The track the bar shows, or null. */
export function currentTrack(s: PlayerState = get()): QueueEntry | null {
  return s.queue?.tracks[s.index] ?? null;
}

let uidSeq = 0;
const entry = (t: QueueTrack, origin: QueueOrigin): QueueEntry => ({ ...t, origin, uid: `q${++uidSeq}` });

/** An album's queue view as entries of the queue. */
function albumEntries(view: PlayerQueueView, origin: QueueOrigin, fallbackCover: string | null = null): QueueEntry[] {
  return view.tracks.map((t) => entry({ ...t, albumId: view.albumId, coverUrl: view.coverUrl ?? fallbackCover, artists: view.artists ?? [], year: view.year ?? null }, origin));
}

/** What the album page passes to Play, so the bar has a title before the queue arrives. */
export interface AlbumRef { albumId: string; title: string; artist: string; coverUrl: string | null }

// ---- the elements ----

let elements: [HTMLAudioElement, HTMLAudioElement] | null = null;
let active = 0;
/** the track the active element holds, and what has been heard of it */
let cur: { trackId: string; index: number; format: StreamFormat; base: number; triedFallback: boolean; started: boolean; completed: boolean; heardSec: number; lastTime: number | null } | null = null;
/**
 * the next track waiting in the other element; a DJ fade loads it from near
 * where it comes in (`base` for a transcode, `seeked` for the original)
 */
let preloaded: { index: number; trackId: string; format: StreamFormat; base: number; seeked: boolean } | null = null;
/** the last Play request, for Retry when the queue itself could not be played */
let lastRequest:
  | { kind: 'album'; album: AlbumRef; startTrackId: string | null; shuffle: boolean }
  | { kind: 'tracks'; ids: string[]; context: QueueContext; startTrackId: string | null; shuffle: boolean }
  | null = null;
/** bumped by every load, so a late answer for an old track is ignored */
let generation = 0;
let lastPositionState = 0;
/** the timed switch to the preloaded track near the end of the current one */
let handoffTimer: ReturnType<typeof setTimeout> | null = null;

function clearHandoff() {
  if (handoffTimer) clearTimeout(handoffTimer);
  handoffTimer = null;
  // anything that moves playback (a load, a seek, a pause, casting) ends a DJ fade at once
  cancelMix();
}

const el = () => elements?.[active] ?? null;

// ---- casting ----

/** A cast receiver that plays instead of the elements (the Google Cast SDK). */
export interface RemoteSink {
  /** what the receiver plays as the original file (else a transcode it plays) */
  canPlay: CanPlay;
  load(track: QueueEntry, opts: { format: StreamFormat; offset: number; autoplay: boolean }): void;
  play(): void;
  pause(): void;
  /** within the loaded media (the original file; a transcode is loaded again from the second) */
  seek(sec: number): void;
  setVolume(volume: number): void;
  stop(): void;
}

let sink: RemoteSink | null = null;
/** the elements play to an AirPlay or Remote Playback device */
let routed = false;
/** the cast key was pressed: the element loads cast links before the device picker opens */
let armed = false;
const useLinks = () => routed || armed;

/** Sets `a`'s source for this track: the session URL, or a cast link while casting; `then` runs once it is set (at once, or when the link arrives). */
function assignSrc(a: HTMLAudioElement, trackId: string, format: StreamFormat, offset: number, then: () => void) {
  const bitrate = getPlayerQuality().bitrate;
  if (!useLinks()) {
    a.src = streamUrl(trackId, format, bitrate, offset);
    then();
    return;
  }
  const cached = cachedCastLink(trackId, format, bitrate);
  const cachedSrc = cached ? castSrc(cached, format, offset) : null;
  if (cachedSrc) {
    a.src = cachedSrc;
    then();
    return;
  }
  const gen = generation;
  void fetchCastLink(trackId, format, bitrate).then((view) => castSrc(view, format, offset), () => null).then((src) => {
    if (gen !== generation || cur?.trackId !== trackId) return;
    // no link (PUBLIC_URL unset, or the request failed): the session URL still plays here
    a.src = src ?? streamUrl(trackId, format, bitrate, offset);
    then();
  });
}

/**
 * AirPlay or a Remote Playback device took the elements' sound (or let it
 * go). While it is routed, one element plays everything, from cast links.
 */
export function setElementRoute(on: boolean) {
  if (routed === on) return;
  routed = on;
  if (!on) armed = false;
  if (on) {
    clearHandoff();
    release(standby());
    preloaded = null;
    void relink();
  }
}

/** The playing track, from where it is, on a cast link; false when there is none ready. */
function moveToLink(): boolean {
  const a = el();
  const track = currentTrack();
  if (!a || !cur || !track || !a.getAttribute('src')) return true;
  const position = get().position;
  const offset = Math.floor(position);
  const view = cachedCastLink(track.localTrackId, cur.format, getPlayerQuality().bitrate);
  const src = view ? castSrc(view, cur.format, offset) : null;
  if (!src) return false;
  if (a.getAttribute('src') === src || (cur.format === 'original' && a.getAttribute('src')?.split('?')[0] === src.split('?')[0])) return true;
  const wasPlaying = !a.paused;
  generation++;
  cur.lastTime = null;
  if (cur.format !== 'original') cur.base = offset;
  a.src = src;
  if (cur.format === 'original' && position > 0) {
    a.addEventListener('loadedmetadata', () => { try { a.currentTime = position; } catch { /* not seekable yet */ } }, { once: true });
  }
  if (wasPlaying) startPlayback(a);
  return true;
}

/** As moveToLink, once a link has been made. */
async function relink() {
  const track = currentTrack();
  if (!cur || !track) return;
  const from = cur;
  await fetchCastLink(track.localTrackId, cur.format, getPlayerQuality().bitrate).catch(() => null);
  if (cur === from && useLinks()) moveToLink();
}

/**
 * The cast key was pressed: the playing track moves to a cast link now (from
 * the cache: the picker must open in the same click), so the device the
 * person picks can fetch it. Without a link ready, one is made and the track
 * moves to it when it arrives.
 */
export function armCastLinks(): boolean {
  armed = true;
  if (moveToLink()) return true;
  void relink();
  return false;
}

/** The picker closed without a device: tracks load from the session URL again. */
export function disarmCastLinks() {
  if (!routed) armed = false;
}

/** A receiver plays from now on: the elements go quiet and the track moves there, from where it was. */
export function attachSink(next: RemoteSink) {
  const s = get();
  const wasPlaying = s.status === 'playing' || s.status === 'buffering' || s.status === 'loading';
  clearHandoff();
  generation++;
  release(el());
  release(standby());
  preloaded = null;
  sink = next;
  sink.setVolume(s.volume);
  if (s.queue && s.index >= 0) loadTrack(s.index, { offset: s.position, keepSession: true, autoplay: wasPlaying });
}

/** The receiver went away (the session ended): paused here where it was; Play goes on in this browser. */
export function detachSink() {
  if (!sink) return;
  sink = null;
  generation++;
  if (get().status !== 'idle') set({ status: 'paused' });
  setPlaybackState('paused');
}

/** The receiver's clock. */
export function sinkTime(currentTime: number, duration: number | null) {
  if (!sink || !cur) return;
  const playing = get().status === 'playing';
  if (playing) cur.heardSec += heardDelta(cur.lastTime, currentTime);
  cur.lastTime = playing ? currentTime : null;
  const track = currentTrack();
  set({ position: shownPosition(cur.base, currentTime), duration: shownDuration(cur.format, track?.durationMs ?? null, duration ?? Number.NaN) });
  const t = Date.now();
  if (t - lastPositionState > 1000) { lastPositionState = t; updatePositionState(); }
  if (t - lastPositionSave > POSITION_SAVE_MS) { lastPositionSave = t; persistSoon(); }
}

/** The receiver plays, pauses or waits for data. */
export function sinkState(state: 'playing' | 'paused' | 'buffering') {
  if (!sink || !cur) return;
  if (state === 'playing') { markPlaying(); return; }
  if (state === 'buffering') { if (get().status !== 'paused') set({ status: 'buffering' }); return; }
  cur.lastTime = null;
  if (get().status !== 'error') set({ status: 'paused' });
  setPlaybackState('paused');
  if (claimed) persistSoon();
}

/** The receiver played the track to its end: the next one of tagave's queue goes there. */
export function sinkEnded() {
  if (sink && cur && !cur.completed) advance(false);
}

/** The receiver could not play the track. */
export function sinkFailed(message: string) {
  if (sink) showError(message, 'stream');
}

/** The volume changed on the receiver (its own remote, another phone). */
export function sinkVolume(volume: number) {
  if (sink && Number.isFinite(volume)) set({ volume: Math.min(1, Math.max(0, volume)) });
}

/** The two elements once playback has created them, for the equalizer glow's analyser (adaptive/levels.ts). */
export function mediaElements(): readonly HTMLAudioElement[] {
  return elements ?? [];
}
const standby = () => elements?.[1 - active] ?? null;
const canPlayOf = (a: HTMLAudioElement | null): CanPlay => (type) => {
  try { return a?.canPlayType(type) ?? ''; } catch { return ''; }
};

function ensureElements(): [HTMLAudioElement, HTMLAudioElement] | null {
  if (elements) return elements;
  if (typeof Audio === 'undefined') return null;
  elements = [new Audio(), new Audio()];
  for (const a of elements) {
    a.preload = 'auto';
    a.volume = get().volume;
    a.addEventListener('playing', () => onPlaying(a));
    a.addEventListener('pause', () => onPause(a));
    a.addEventListener('waiting', () => { if (a === el() && get().status === 'playing') set({ status: 'buffering' }); });
    a.addEventListener('timeupdate', () => onTime(a));
    a.addEventListener('durationchange', () => onDuration(a));
    a.addEventListener('loadedmetadata', () => onDuration(a));
    a.addEventListener('seeking', () => { if (a === el() && cur) cur.lastTime = null; });
    a.addEventListener('seeked', () => { if (a === el() && cur) cur.lastTime = a.currentTime; });
    a.addEventListener('ended', () => onEnded(a));
    a.addEventListener('error', () => onError(a));
    // Safari offers AirPlay for an <audio> it may route there
    try { a.setAttribute('x-webkit-airplay', 'allow'); } catch { /* not an element here */ }
  }
  setupMediaSession();
  for (const w of elementWatchers) w(elements);
  return elements;
}

const elementWatchers = new Set<(els: readonly HTMLAudioElement[]) => void>();

/** Calls `watch` with the two elements once they exist (now, if they do): casting listens on them. */
export function watchElements(watch: (els: readonly HTMLAudioElement[]) => void): () => void {
  elementWatchers.add(watch);
  if (elements) watch(elements);
  return () => { elementWatchers.delete(watch); };
}

/** The elements, made now if they were not yet (casting asks before anything played). */
export function ensurePlayerElements(): readonly HTMLAudioElement[] {
  return ensureElements() ?? [];
}

/** The element that plays (the one AirPlay or Remote Playback is asked for). */
export function activeElement(): HTMLAudioElement | null {
  return el();
}

function release(a: HTMLAudioElement | null) {
  if (!a) return;
  try {
    a.pause();
    a.removeAttribute('src');
    a.load();
  } catch { /* nothing to release */ }
}

/** `onRefused`: what to do instead when the browser will not start this element without a tap. */
function startPlayback(a: HTMLAudioElement, onRefused?: () => void) {
  const p = a.play();
  if (p && typeof p.catch === 'function') {
    p.catch((err: unknown) => {
      if (a !== el() || (err as { name?: string })?.name !== 'NotAllowedError') return;
      // AbortError: a newer load replaced this one; a failed load arrives as `error`
      if (onRefused) onRefused();
      // autoplay refused (no gesture yet, or playback handed here): wait for the listener's Play
      else set({ status: 'paused', needsTap: true });
    });
  }
}

/** Loads the queue's track `index` into the active element. */
function loadTrack(index: number, opts: { offset?: number; format?: StreamFormat; keepSession?: boolean; autoplay?: boolean } = {}) {
  const els = ensureElements();
  const s = get();
  const track = s.queue?.tracks[index];
  if (!els || !track) return;
  // a play here: this device plays from now on, not the other one
  if (remoteCtl) leaveRemote();
  generation++;
  const a = els[active]!;
  const format = opts.format ?? chooseFormat(getPlayerQuality(), track.mime, sink ? sink.canPlay : canPlayOf(a));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const keep = opts.keepSession && cur?.trackId === track.localTrackId;
  cur = {
    trackId: track.localTrackId,
    index,
    format,
    base: format === 'original' ? 0 : offset,
    triedFallback: keep ? cur!.triedFallback || opts.format !== undefined : false,
    started: keep ? cur!.started : false,
    completed: false,
    heardSec: keep ? cur!.heardSec : 0,
    lastTime: null,
  };
  clearHandoff();
  endRamp();
  const nextIdx = nextPlayable(s.queue!.tracks, index);
  if (preloaded && preloaded.trackId !== s.queue!.tracks[nextIdx]?.localTrackId) { release(standby()); preloaded = null; }
  djPrepare(index);
  set({ index, status: 'loading', message: null, retry: null, needsTap: false, position: offset, duration: shownDuration(format, track.durationMs, Number.NaN) });
  updateMetadata(track);
  persistSoon();
  if (sink) {
    sink.load(track, { format, offset, autoplay: opts.autoplay !== false });
    if (opts.autoplay === false) set({ status: 'paused' });
    return;
  }
  // the key armed links for the picker, and no device was chosen: the session URL again
  if (!routed) armed = false;
  a.playbackRate = 1;
  const g = elementGain(a);
  if (g) setGainNow(g, 1);
  djGesture();
  assignSrc(a, track.localTrackId, format, offset, () => {
    if (format === 'original' && offset > 0) {
      const seekTo = offset;
      a.addEventListener('loadedmetadata', () => { try { a.currentTime = seekTo; } catch { /* not seekable yet */ } }, { once: true });
    }
    if (opts.autoplay === false) set({ status: 'paused' });
    else startPlayback(a);
  });
}

// ---- element events ----

function onPlaying(a: HTMLAudioElement) {
  if (a !== el() || !cur) return;
  cur.lastTime = a.currentTime;
  markPlaying();
}

/** The track sounds (here or on the receiver): the first time, now playing; this device plays now. */
function markPlaying() {
  if (!cur) return;
  set({ status: 'playing', message: null, retry: null, needsTap: false });
  if (!cur.started) {
    cur.started = true;
    sendEvent('now_playing');
  }
  // this device plays now: say so at once, so another one pauses
  if (!claimed) { claimed = true; persistNow({ mode: 'play' }); }
  setPlaybackState('playing');
}

function onPause(a: HTMLAudioElement) {
  if (a !== el() || a.ended) return;
  clearHandoff();
  const { status } = get();
  // a src change pauses too; that is a load, not the listener pausing
  if (status === 'playing' || status === 'buffering') set({ status: 'paused' });
  if (cur) cur.lastTime = null;
  setPlaybackState('paused');
  // paused from the lock screen or a car: the page may be frozen before a timer runs
  if (claimed) { if (pageHidden()) persistNow(); else persistSoon(); }
}

function pageHidden(): boolean {
  return globalThis.document?.visibilityState === 'hidden';
}

function onTime(a: HTMLAudioElement) {
  if (a !== el() || !cur) return;
  const now = a.currentTime;
  if (!a.paused && !a.seeking) cur.heardSec += heardDelta(cur.lastTime, now);
  cur.lastTime = a.paused ? null : now;
  const position = shownPosition(cur.base, now);
  const track = currentTrack();
  const duration = shownDuration(cur.format, track?.durationMs ?? null, a.duration);
  set({ position, duration });
  tickRamp();
  // a DJ fade on its way (or the next one planned) takes the place of the handoff below
  if (mix) mixTick();
  else if (!djTime(a, position, duration)) {
    if (!preloaded && shouldPreload(position, duration)) preloadNext();
  }
  if (preloaded && !handoffTimer && !mix && !djFadeAhead) {
    const b = standby();
    const delay = handoffDelayMs(position, duration, !!b && b.readyState >= 3, a.paused);
    if (delay != null) {
      const from = cur.trackId;
      handoffTimer = setTimeout(() => {
        handoffTimer = null;
        // still the same track, still playing: start the next one now
        if (cur?.trackId === from && !el()?.paused) advance(true);
      }, delay);
    }
  }
  const t = Date.now();
  if (t - lastPositionState > 1000) { lastPositionState = t; updatePositionState(); }
  if (t - lastPositionSave > POSITION_SAVE_MS) { lastPositionSave = t; persistSoon(); }
}

function onDuration(a: HTMLAudioElement) {
  if (a !== el() || !cur) return;
  set({ duration: shownDuration(cur.format, currentTrack()?.durationMs ?? null, a.duration) });
  updatePositionState();
}

function onEnded(a: HTMLAudioElement) {
  if (a !== el() || !cur) return;
  advance(false);
}

/**
 * The current track is done: at its `ended`, or (early) from the handoff
 * timer a moment before it, so the next one is already sounding when this
 * one stops.
 */
function advance(early: boolean) {
  if (sink && cur) {
    cur.completed = true;
    set({ position: get().duration ?? get().position });
    sendEvent('completed');
    const n = nextPlayable(get().queue?.tracks ?? [], get().index);
    if (n < 0) { set({ status: 'paused' }); setPlaybackState('paused'); return; }
    loadTrack(n);
    return;
  }
  const a = el();
  if (!a || !cur) return;
  // the track ran out while the next one was already starting under it (a late timer): straight into it
  if (mix && mix.phase === 'preroll' && mix.from === a && !mix.to.paused) {
    swapToIncoming();
    finishMix();
    return;
  }
  clearHandoff();
  if (early) {
    // only straight into a loaded next track; anything else waits for `ended`
    const tracks = get().queue?.tracks ?? [];
    const n = nextPlayable(tracks, get().index);
    if (n < 0 || !preloaded || preloaded.trackId !== tracks[n]!.localTrackId) return;
  }
  cur.completed = true;
  if (early && a.currentTime > 0) cur.heardSec += heardDelta(cur.lastTime, a.currentTime);
  set({ position: get().duration ?? get().position });
  sendEvent('completed');
  const s = get();
  const tracks = s.queue?.tracks ?? [];
  const next = nextPlayable(tracks, s.index);
  if (next < 0) {
    // the end of the album: rest on the last track; Play starts it over
    set({ status: 'paused' });
    setPlaybackState('paused');
    return;
  }
  // a track a DJ fade had loaded from a later second (a transcode) loads again from its start
  if (preloaded && preloaded.base > 0) { release(standby()); preloaded = null; }
  if (preloaded && preloaded.trackId === tracks[next]!.localTrackId && elements) {
    const p = preloaded;
    preloaded = null;
    const old = a;
    active = 1 - active;
    const b = elements[active]!;
    if (p.seeked) { try { b.currentTime = 0; } catch { /* plays from where it is */ } }
    b.playbackRate = 1;
    const gb = elementGain(b);
    if (gb) setGainNow(gb, 1);
    generation++;
    cur = { trackId: p.trackId, index: next, format: p.format, base: 0, triedFallback: false, started: false, completed: false, heardSec: 0, lastTime: null };
    const track = tracks[next]!;
    set({ index: next, status: 'loading', message: null, retry: null, position: 0, duration: shownDuration(p.format, track.durationMs, b.duration) });
    updateMetadata(track);
    persistSoon();
    djPrepare(next);
    startPlayback(b, () => {
      // The preloaded element may not start without a tap (iOS allows play()
      // only on an element a tap started once; with the screen locked there
      // is no tap): the track loads into the element that just played.
      if (el() !== b || cur?.trackId !== p.trackId) return;
      release(b);
      active = 1 - active;
      loadTrack(get().index);
    });
    if (early) {
      // the old track's last few milliseconds play out under the new one's start
      const src = old.getAttribute('src');
      setTimeout(() => { if (old !== el() && old.getAttribute('src') === src) release(old); }, 150);
    } else {
      release(old);
    }
    return;
  }
  loadTrack(next);
}

/** Loads the next track into the other element; `startAt` (a DJ fade): from near where it comes in. */
function preloadNext(startAt = 0) {
  const s = get();
  const b = standby();
  if (!s.queue || !b) return;
  const next = nextPlayable(s.queue.tracks, s.index);
  if (next < 0) return;
  const track = s.queue.tracks[next]!;
  const format = chooseFormat(getPlayerQuality(), track.mime, canPlayOf(b));
  if (useLinks()) {
    // one element plays to the device: only the next track's link is made ready (once)
    if (cachedCastLink(track.localTrackId, format, getPlayerQuality().bitrate)) return;
    void fetchCastLink(track.localTrackId, format, getPlayerQuality().bitrate).catch(() => undefined);
    return;
  }
  const from = Math.max(0, startAt);
  const base = format === 'original' ? 0 : Math.floor(from);
  const p = { index: next, trackId: track.localTrackId, format, base, seeked: false };
  preloaded = p;
  b.preload = 'auto';
  b.src = streamUrl(track.localTrackId, format, getPlayerQuality().bitrate, base);
  try { b.load(); } catch { /* loads on play */ }
  b.playbackRate = 1;
  if (format === 'original' && from > 0) {
    b.addEventListener('loadedmetadata', () => {
      if (preloaded !== p || standby() !== b) return;
      try { b.currentTime = from; p.seeked = true; } catch { /* not seekable yet: the fade seeks */ }
    }, { once: true });
  }
}

// ---- the DJ module, Simple mode: crossfades and tempo transitions (djPlan.ts) ----
//
// While the module is on, the person's crossfade is not Off and this device
// can mix (not an iOS home-screen app), the two elements run through the
// page's graph (audioGraph.ts), made from a play gesture. A fade is gain
// automation on the audio clock (equal power); el.play() is not on that
// clock, so the incoming element starts a little early, silent, and is kept
// on the outgoing one's beat by nudging its playbackRate until and through
// the fade. Anything the person does (pause, seek, next, a queue change,
// casting) ends a fade at once: the incoming track plays on at full gain.
// Nothing here may stop playback: without the analysis, the graph, or a
// started element, the transition is today's gapless handoff.

/** the analysis per track: absent until asked, null when there is none */
const djInfo = new Map<string, DjTrackInfo | null>();
/** GET /me/dj/tracks answered 404: the module is off on the server */
let djServerOff = false;
/** the playing track's next transition is a fade: no gapless handoff timer */
let djFadeAhead = false;

/** The incoming element starts this long before its fade, silent (gain 0). */
const PREROLL_SEC = 0.6;
/** el.play() to sound (Chrome, measured for rr82): the element is started this much early. */
const START_LATENCY_SEC = 0.03;
/**
 * How far the lock may move the incoming rate while it is silent. Once the
 * fade begins both elements run on the same audio clock at fixed rates, so
 * they stay together without it (measured: a lock during the fade only added
 * the time-stretcher's jitter).
 */
const LOCK_PREROLL_SLEW = 0.15;
/** Before the fade, an incoming element further off than this is moved there. */
const RESEEK_SEC = 0.12;

type FadePlan = Extract<DjTransition, { kind: 'fade' }>;

interface Mix {
  /** armed: the next one waits; preroll: it plays, silent; fading: it is the current track */
  phase: 'armed' | 'preroll' | 'fading';
  from: HTMLAudioElement;
  to: HTMLAudioElement;
  fromBase: number;
  toBase: number;
  plan: FadePlan;
  nextIndex: number;
  trackId: string;
  format: StreamFormat;
  /** the audio-clock second the fade ends */
  fadeEndCtx: number;
}
let mix: Mix | null = null;
/** after a tempo-matched fade: the incoming track easing back to its own tempo */
let ramp: { el: HTMLAudioElement; fromRate: number; startPos: number; lengthSec: number } | null = null;
let djTimer: ReturnType<typeof setInterval> | null = null;

/** DJ runs now: wanted, this device plays its own elements, and the graph runs. */
function djOn(): boolean {
  if (!djWanted() || sink || useLinks() || remoteCtl || !elements) return false;
  const c = existingContext();
  return !!c && c.state === 'running' && allRouted(elements);
}

/** A play gesture: route the elements once (DJ wanted), or resume a context the browser stopped. */
function djGesture() {
  if (!elements || sink || useLinks()) return;
  if (allRouted(elements)) { void resumeGraph(); return; }
  if (djWanted()) void routeElements(elements);
}

/** when each track was last asked for: one not measured yet is asked again (the first ask queued its analysis) */
const djAskedAt = new Map<string, number>();
const DJ_ASK_AGAIN_MS = 20_000;
const measured = (i: DjTrackInfo | null | undefined) => !!i && (i.trimEndMs != null || i.bpm != null);

/** Asks for the analysis of this track and the next two (never waited for; again later while one is not measured yet). */
function djPrepare(index: number) {
  if (!djWanted() || djServerOff) return;
  const tracks = get().queue?.tracks ?? [];
  const ids: string[] = [];
  const now = Date.now();
  for (let i = index, k = 0; i >= 0 && k < 3; i = nextPlayable(tracks, i), k++) {
    const t = tracks[i];
    if (!t || ids.includes(t.localTrackId) || measured(djInfo.get(t.localTrackId))) continue;
    const at = djAskedAt.get(t.localTrackId);
    if (at == null || now - at > DJ_ASK_AGAIN_MS) ids.push(t.localTrackId);
  }
  if (ids.length === 0) return;
  for (const id of ids) { djAskedAt.set(id, now); if (!djInfo.has(id)) djInfo.set(id, null); }
  void api.get<Array<DjTrackInfo | null>>(`/me/dj/tracks?ids=${ids.map(encodeURIComponent).join(',')}`).then(
    (list) => { for (const info of Array.isArray(list) ? list : []) if (info?.localTrackId) djInfo.set(info.localTrackId, info); },
    (err: ApiError) => { if (err?.status === 404) djServerOff = true; },
  );
}

/** The playing track's way into the next one. */
function djNextPlan(a: HTMLAudioElement): { next: number; plan: DjTransition } | null {
  const tracks = get().queue?.tracks;
  if (!tracks || !cur) return null;
  const next = nextPlayable(tracks, cur.index);
  const out = tracks[cur.index];
  const inc = tracks[next];
  if (next < 0 || !out || !inc) return null;
  const plan = planTransition(
    trackFacts(out, djInfo.get(out.localTrackId), cur.format === 'original' ? a.duration : null),
    trackFacts(inc, djInfo.get(inc.localTrackId)),
    getDjSettings(),
  );
  return { next, plan };
}

/** On the playing element's timeupdate: loads and arms a planned fade. False: today's handoff applies. */
function djTime(a: HTMLAudioElement, position: number, duration: number | null): boolean {
  djFadeAhead = false;
  if (!djOn() || !cur || a.paused) return false;
  // a track measured since it was first asked for (asks again at most every 20 s)
  djPrepare(cur.index);
  const p = djNextPlan(a);
  if (!p || p.plan.kind !== 'fade') return false;
  const plan = p.plan;
  // too late for this one (a seek near the end): the plain handoff
  if (position > plan.startSec + plan.lengthSec - 1) return false;
  djFadeAhead = true;
  if (!preloaded && duration != null && position >= preloadAtSec(plan, duration)) preloadNext(plan.inAtSec - 1.5 * plan.rateIn);
  if (preloaded && preloaded.index === p.next && position >= plan.startSec - PREROLL_SEC - 1.5) armMix(p.next, plan);
  return true;
}

function setPitchKept(a: HTMLAudioElement) {
  try { a.preservesPitch = true; } catch { /* not settable here */ }
  try { (a as HTMLAudioElement & { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true; } catch { /* older Safari */ }
}

function armMix(nextIndex: number, plan: FadePlan) {
  const a = el();
  const b = standby();
  const ga = elementGain(a);
  const gb = elementGain(b);
  if (!a || !b || !ga || !gb || !preloaded || !cur) return;
  mix = { phase: 'armed', from: a, to: b, fromBase: cur.base, toBase: preloaded.base, plan, nextIndex, trackId: preloaded.trackId, format: preloaded.format, fadeEndCtx: Number.POSITIVE_INFINITY };
  setGainNow(gb, 0);
  setGainNow(ga, 1);
  setPitchKept(b);
  b.playbackRate = plan.rateIn;
  syncDjTimer();
  mixTick();
}

/** Every 20 ms while a fade is on its way (and on each timeupdate, which a background tab still gets). */
function mixTick() {
  const m = mix;
  if (!m) return;
  const ctx = existingContext();
  if (!ctx) { cancelMix(); return; }
  const { from: a, to: b, plan } = m;
  const rateA = a.playbackRate || 1;
  const posA = m.fromBase + a.currentTime;
  if (m.phase === 'armed') {
    if (a.paused) return;
    if (posA > plan.startSec + plan.lengthSec - 1) { cancelMix(); return; }
    const dt = (plan.startSec - posA) / rateA;
    if (dt > PREROLL_SEC + START_LATENCY_SEC) return;
    // where the incoming track should be when its sound starts, START_LATENCY_SEC from now
    const at = plan.inAtSec - (dt - START_LATENCY_SEC) * plan.rateIn;
    // it comes in at its very start: wait until that is due
    if (at < 0) return;
    const local = at - m.toBase;
    if (local < 0) { cancelMix(); return; }
    try { if (Math.abs(b.currentTime - local) > 0.005) b.currentTime = local; } catch { /* not seekable yet */ }
    m.phase = 'preroll';
    const started = () => { if (mix === m) scheduleFade(m); };
    const p = b.play();
    if (p && typeof p.then === 'function') p.then(started, () => { if (mix === m) cancelMix(); });
    else started();
    return;
  }
  // silent, the incoming track is pulled onto the outgoing one's beat
  if (m.phase === 'preroll' && plan.beatAligned && !b.paused && b.readyState >= 3 && !a.paused) {
    const want = expectedIncoming(posA, plan.startSec, plan.inAtSec, plan.rateIn, rateA);
    const err = m.toBase + b.currentTime - want;
    if (Math.abs(err) > RESEEK_SEC) {
      try { b.currentTime = want + START_LATENCY_SEC * plan.rateIn - m.toBase; } catch { /* next tick */ }
    } else {
      b.playbackRate = lockRate(err, plan.rateIn, LOCK_PREROLL_SLEW);
    }
  }
  if (m.phase === 'preroll' && posA >= plan.startSec) {
    if (b.paused || b.readyState < 3) {
      // the next one did not start in time: the outgoing track plays out, the handoff follows
      if (posA > plan.startSec + plan.lengthSec / 2) cancelMix();
      return;
    }
    b.playbackRate = plan.rateIn;
    swapToIncoming();
    return;
  }
  if (m.phase === 'fading' && ctx.currentTime >= m.fadeEndCtx) finishMix();
}

/** The incoming element sounds: both gains move on the audio clock, from the fade's start (or as far in as it already is). */
function scheduleFade(m: Mix) {
  const ctx = existingContext();
  const ga = elementGain(m.from);
  const gb = elementGain(m.to);
  if (!ctx || !ga || !gb) { cancelMix(); return; }
  const rateA = m.from.playbackRate || 1;
  const posA = m.fromBase + m.from.currentTime;
  const now = ctx.currentTime;
  const wallLength = m.plan.lengthSec / rateA;
  const dt = (m.plan.startSec - posA) / rateA;
  const progress = dt < 0 ? Math.min(0.95, -dt / wallLength) : 0;
  const at = now + Math.max(0.01, dt);
  const length = Math.max(0.05, wallLength * (1 - progress));
  try {
    ga.gain.cancelScheduledValues(0);
    ga.gain.setValueAtTime(1, now);
    ga.gain.setValueCurveAtTime(equalPowerFrom(256, false, progress), at, length);
    gb.gain.cancelScheduledValues(0);
    gb.gain.setValueAtTime(0, now);
    gb.gain.setValueCurveAtTime(equalPowerFrom(256, true, progress), at, length);
  } catch {
    ga.gain.cancelScheduledValues(0);
    gb.gain.cancelScheduledValues(0);
    ga.gain.setValueAtTime(1, now);
    gb.gain.setValueAtTime(0, now);
    ga.gain.linearRampToValueAtTime(0, at + length);
    gb.gain.linearRampToValueAtTime(1, at + length);
  }
  m.fadeEndCtx = at + length;
}

/** The fade begins: the outgoing track is done, the incoming one is the current track (the bar, the events, the queue). */
function swapToIncoming() {
  const m = mix;
  if (!m || !elements) return;
  if (cur) {
    if (m.from.currentTime > 0) cur.heardSec += heardDelta(cur.lastTime, m.from.currentTime);
    cur.completed = true;
    set({ position: get().duration ?? get().position });
    sendEvent('completed');
  }
  active = elements.indexOf(m.to) as 0 | 1;
  generation++;
  preloaded = null;
  const track = get().queue?.tracks[m.nextIndex];
  cur = { trackId: m.trackId, index: m.nextIndex, format: m.format, base: m.toBase, triedFallback: false, started: false, completed: false, heardSec: 0, lastTime: m.to.currentTime };
  m.phase = 'fading';
  const lengthMs = Math.round((m.plan.lengthSec / (m.from.playbackRate || 1)) * 1000);
  set({
    index: m.nextIndex, message: null, retry: null, mix: { lengthMs, at: Date.now() },
    position: shownPosition(m.toBase, m.to.currentTime),
    duration: track ? shownDuration(m.format, track.durationMs, m.to.duration) : null,
  });
  if (track) updateMetadata(track);
  markPlaying();
  persistSoon();
  djPrepare(m.nextIndex);
}

/** The fade is over (or cut short): the outgoing element goes, the incoming one at full gain; a tempo-matched one eases back. */
function finishMix() {
  const m = mix;
  if (!m) return;
  mix = null;
  release(m.from);
  const ga = elementGain(m.from);
  if (ga) setGainNow(ga, 1);
  const gb = elementGain(m.to);
  if (gb) setGainNow(gb, 1);
  if (get().mix) set({ mix: null });
  if (m.plan.rampSec > 0 && cur && el() === m.to) {
    ramp = { el: m.to, fromRate: m.to.playbackRate, startPos: cur.base + m.to.currentTime, lengthSec: m.plan.rampSec };
  } else {
    m.to.playbackRate = 1;
  }
  syncDjTimer();
}

/** Ends a fade at once. Before it began: the next track waits again, silent and paused. */
function cancelMix() {
  const m = mix;
  if (!m) return;
  if (m.phase === 'fading') { finishMix(); return; }
  mix = null;
  try { m.to.pause(); } catch { /* already stopped */ }
  m.to.playbackRate = 1;
  if (preloaded) preloaded.seeked = true;
  const ga = elementGain(m.from);
  if (ga) setGainNow(ga, 1);
  const gb = elementGain(m.to);
  if (gb) setGainNow(gb, 1);
  syncDjTimer();
}

/** Along the ease back to the track's own tempo (on timeupdate and the DJ timer). */
function tickRamp() {
  const r = ramp;
  if (!r) return;
  const a = el();
  if (a !== r.el || !cur) { endRamp(); return; }
  const p = (cur.base + a.currentTime - r.startPos) / r.lengthSec;
  if (p >= 1) { endRamp(); return; }
  const rate = rampRate(r.fromRate, p);
  if (Math.abs(a.playbackRate - rate) > 0.0005) a.playbackRate = rate;
}

function endRamp() {
  const r = ramp;
  ramp = null;
  if (r) { try { r.el.playbackRate = 1; } catch { /* released */ } }
  syncDjTimer();
}

function syncDjTimer() {
  const wanted = !!mix || !!ramp;
  if (wanted && !djTimer) {
    djTimer = setInterval(() => { if (mix) mixTick(); tickRamp(); }, 20);
  } else if (!wanted && djTimer) {
    clearInterval(djTimer);
    djTimer = null;
  }
}

// DJ turned off (or this device can no longer mix): a fade ends, the gains go back to 1, the graph stays
subscribeDj(() => {
  if (djWanted()) return;
  cancelMix();
  endRamp();
  resetGains();
});

// the browser stopped the context (a call, the lock screen, a Bluetooth switch): nothing stays half faded,
// and a player that would be silent is shown paused, so the next Play (a gesture) resumes it
onContextTrouble(() => {
  cancelMix();
  resetGains();
  setTimeout(() => {
    const c = existingContext();
    const a = el();
    if (c && c.state !== 'running' && a && !a.paused && elements && allRouted(elements)) pause();
  }, 1500);
});

/** A one-byte request to the stream URL: its status tells a 409 or 429 from a decode failure. */
async function probe(url: string): Promise<number | null> {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  try {
    const res = await fetch(url, { credentials: 'include', headers: { Range: 'bytes=0-0' }, ...(ctrl ? { signal: ctrl.signal } : {}) });
    const status = res.status;
    try { void res.body?.cancel(); } catch { /* already closed */ }
    ctrl?.abort();
    return status;
  } catch {
    return null;
  }
}

async function onError(a: HTMLAudioElement) {
  if (a !== el()) {
    // the preload failed: drop it, the track loads normally when its turn comes
    if (a === standby()) { if (mix?.to === a) cancelMix(); preloaded = null; release(a); }
    return;
  }
  if (!cur || !a.getAttribute('src')) return;
  const gen = generation;
  const failing = cur;
  const status = await probe(a.currentSrc || a.src);
  if (gen !== generation || cur !== failing) return;
  const kind = classifyFailure({ probe: status, format: failing.format, triedFallback: failing.triedFallback });
  const s = get();
  if (kind === 'skip') {
    markUnavailable(failing.index);
    const tracks = get().queue?.tracks ?? [];
    const next = nextPlayable(tracks, failing.index);
    if (next >= 0) { loadTrack(next); return; }
    showError(nothingPlayableMessage({ scanRequested: true, tracks, scan: get().queue?.scan ?? null }), 'queue');
    return;
  }
  if (kind === 'fallback') {
    loadTrack(failing.index, { format: transcodeFormat(canPlayOf(a)), offset: s.position, keepSession: true });
    return;
  }
  showError(FAILURE_TEXT[kind], 'stream');
}

function markUnavailable(index: number) {
  const q = get().queue;
  if (!q) return;
  const tracks = q.tracks.map((t, i) => (i === index ? { ...t, available: false, reason: t.reason ?? 'not_scanned' as const } : t));
  set({ queue: { ...q, tracks } });
}

function showError(message: string, retry: PlayerState['retry']) {
  try { el()?.pause(); } catch { /* already stopped */ }
  set({ status: 'error', message, retry, loadingAlbumId: null });
  setPlaybackState('paused');
}

// ---- play events ----

const MAX_MS = 24 * 3600_000;
const clampMs = (sec: number) => Math.min(MAX_MS, Math.max(0, Math.round(sec * 1000)));

/** Fire and forget: never blocks playback, never retries. */
function sendEvent(kind: PlayEventKind) {
  const s = get();
  if (!cur || !s.queueId || typeof fetch === 'undefined') return;
  const body = JSON.stringify({ kind, localTrackId: cur.trackId, queueId: s.queueId, playedMs: clampMs(cur.heardSec), positionMs: clampMs(s.position) });
  try {
    void fetch('/api/v1/player/events', { method: 'POST', body, keepalive: true, credentials: 'include', headers: { 'Content-Type': 'application/json' } }).catch(() => undefined);
  } catch { /* dropped */ }
}

/** Moving away from a track that started and did not finish: a skip. */
function leaveCurrent() {
  if (cur && cur.started && !cur.completed) sendEvent('skipped');
  cur = null;
}

// ---- Media Session ----

function session(): MediaSession | null {
  try { return typeof navigator !== 'undefined' && 'mediaSession' in navigator ? navigator.mediaSession : null; } catch { return null; }
}

/**
 * The lock screen, the notification, headphones, a car's steering-wheel keys
 * (Bluetooth AVRCP) and CarPlay/Android Auto's "now playing" all come here.
 * On iPhone and iPad the ±10 s seek actions are left out: with them iOS
 * shows skip-10-seconds buttons in place of previous/next track, and a car's
 * next key may skip ten seconds instead of a track.
 */
function setupMediaSession() {
  const ms = session();
  if (!ms) return;
  const apple = isAppleMobile();
  const handlers: Array<[MediaSessionAction, MediaSessionActionHandler | null]> = [
    ['play', () => play()],
    ['pause', () => pause()],
    ['previoustrack', () => previous()],
    ['nexttrack', () => next()],
    ['stop', () => stop()],
    ['seekto', (d) => { if (d.seekTime != null) seek(d.seekTime); }],
    ['seekbackward', apple ? null : (d) => seek(get().position - (d.seekOffset ?? 10))],
    ['seekforward', apple ? null : (d) => seek(get().position + (d.seekOffset ?? 10))],
  ];
  for (const [action, handler] of handlers) {
    try { ms.setActionHandler(action, handler); } catch { /* this browser does not know the action */ }
  }
}

function artworkType(url: string): string | undefined {
  const ext = url.split('?')[0]!.split('.').pop()?.toLowerCase();
  return ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : undefined;
}

/** The app icon, for a track without a cover: a lock screen or car display never shows a blank square. */
const APP_ARTWORK: readonly MediaImage[] = [
  { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
  { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
];

/**
 * A track's artwork for the Media Session, as absolute URLs. The cover
 * endpoint (/api/v1/images/album/:id) sends one 300 px thumbnail, so it is
 * listed at that size and the platform scales it.
 */
export function artworkFor(coverUrl: string | null | undefined, base: string | undefined = globalThis.location?.href): MediaImage[] {
  const abs = (u: string) => new URL(u, base).href;
  if (!coverUrl) return APP_ARTWORK.map((a) => ({ ...a, src: abs(a.src) }));
  const src = abs(coverUrl);
  const type = artworkType(src);
  return [{ src, sizes: '300x300', ...(type ? { type } : {}) }];
}

function updateMetadata(track: QueueEntry) {
  const ms = session();
  if (!ms || typeof MediaMetadata === 'undefined') return;
  try {
    ms.metadata = new MediaMetadata({ title: track.title, artist: track.artist || track.albumArtist, album: track.album, artwork: artworkFor(track.coverUrl) });
  } catch { /* metadata is a nicety */ }
}

function setPlaybackState(state: MediaSessionPlaybackState) {
  const ms = session();
  if (!ms) return;
  try { ms.playbackState = state; } catch { /* ignore */ }
  updatePositionState();
}

function updatePositionState() {
  const ms = session();
  const { duration, position } = get();
  if (!ms || typeof ms.setPositionState !== 'function') return;
  try {
    if (duration && Number.isFinite(duration) && duration > 0) ms.setPositionState({ duration, playbackRate: 1, position: Math.min(Math.max(0, position), duration) });
  } catch { /* ignore */ }
}

// ---- actions ----

/** Stops what is loaded, before a new album or playlist starts. */
function resetForNew(): number {
  ensureElements();
  clearHandoff();
  leaveCurrent();
  generation++;
  release(el());
  release(standby());
  preloaded = null;
  return generation;
}

/** Starts `fresh` at its playable track `start` (or shows why nothing plays), keeping the upcoming tracks added by hand. */
function begin(fresh: QueueEntry[], start: number, context: QueueContext | null, extra: Pick<PlayerQueue, 'scanRequested' | 'scan'>, failure: () => string) {
  const old = get();
  const { tracks, index } = startContext(old.queue?.tracks ?? [], old.index, fresh, start);
  set({ queue: { context, tracks, ...extra }, loadingAlbumId: null, index: index < 0 ? -1 : index });
  if (index < 0) {
    showError(failure(), 'queue');
    return;
  }
  loadTrack(index);
}

/**
 * "Play" (the whole album), "Play from here" (startTrackId) or Shuffle (the
 * album in a random order, drawn once: the queue view shows that order).
 * Listens do not depend on the order: the server counts the album's distinct
 * tracks heard within six hours (playerPlays.ts deriveListens).
 */
export async function playAlbum(album: AlbumRef, startTrackId: string | null = null, opts: { shuffle?: boolean } = {}): Promise<void> {
  const shuffle = !!opts.shuffle && !startTrackId;
  lastRequest = { kind: 'album', album, startTrackId, shuffle };
  const gen = resetForNew();
  const keep = get().queue;
  set({ loadingAlbumId: album.albumId, queueId: randomId(), status: 'loading', message: null, retry: null, position: 0, duration: null });
  let view: PlayerQueueView;
  try {
    view = await api.get<PlayerQueueView>(`/player/albums/${encodeURIComponent(album.albumId)}/queue`);
  } catch (err) {
    if (gen !== generation) return;
    const status = (err as ApiError)?.status;
    set({ loadingAlbumId: null, queue: keep ?? { context: { kind: 'album', id: album.albumId, name: album.title }, tracks: [], scanRequested: false } });
    showError(status === 404 ? 'The player is not set up.' : status ? 'tagave could not load this album’s tracks. Try again.' : FAILURE_TEXT.network, 'queue');
    return;
  }
  if (gen !== generation) return;
  const fresh = queueOrder(albumEntries(view, 'context', album.coverUrl), { shuffle });
  const start = startIndex(fresh, startTrackId);
  begin(fresh, start, { kind: 'album', id: album.albumId, name: view.album }, { scanRequested: view.scanRequested, scan: view.scan ?? null },
    () => nothingPlayableMessage({ ...view, tracks: fresh }, startTrackId ? fresh.findIndex((t) => t.localTrackId === startTrackId) : 0));
}

/** Tracks by id, as the queue plays them (any albums, in the order asked). */
export async function fetchQueueTracks(ids: readonly string[]): Promise<QueueTrack[]> {
  if (ids.length === 0) return [];
  return (await api.post<{ tracks: QueueTrack[] }>('/player/tracks', { ids })).tracks;
}

/** An album's tracks, as the queue plays them. */
async function albumTracks(albumId: string): Promise<QueueEntry[]> {
  const view = await api.get<PlayerQueueView>(`/player/albums/${encodeURIComponent(albumId)}/queue`);
  return albumEntries(view, 'queued');
}

/** A playlist (or any list of tracks): Play from a track, or Shuffle (its own order is not disc and track order, so only the shuffle applies). */
export async function playTracks(ids: readonly string[], context: QueueContext, opts: { startTrackId?: string | null; shuffle?: boolean } = {}): Promise<void> {
  const shuffle = !!opts.shuffle && !opts.startTrackId;
  lastRequest = { kind: 'tracks', ids: [...ids], context, startTrackId: opts.startTrackId ?? null, shuffle };
  const gen = resetForNew();
  set({ loadingAlbumId: null, queueId: randomId(), status: 'loading', message: null, retry: null, position: 0, duration: null });
  let tracks: QueueTrack[];
  try {
    tracks = await fetchQueueTracks(ids);
  } catch (err) {
    if (gen !== generation) return;
    const status = (err as ApiError)?.status;
    showError(status === 404 ? 'The player is not set up.' : status ? 'tagave could not load these tracks. Try again.' : FAILURE_TEXT.network, 'queue');
    return;
  }
  if (gen !== generation) return;
  const listed = tracks.map((t) => entry(t, 'context'));
  const fresh = shuffle ? shuffleTracks(listed) : listed;
  const start = startIndex(fresh, opts.startTrackId ?? null);
  begin(fresh, start, context, { scanRequested: false, scan: null }, () => nothingPlayableMessage({ tracks: fresh, scanRequested: false }));
}

/** What Play next and Add to queue take: tracks by id, or an album. */
export type QueueSource = { trackIds: string[] } | { albumId: string };

/**
 * Play next (right after the playing track) or Add to queue (after the
 * other tracks added by hand). With nothing playing, they start playing.
 * Resolves to how many tracks went in.
 */
export async function enqueue(source: QueueSource, where: 'next' | 'end'): Promise<number> {
  const added = 'albumId' in source ? await albumTracks(source.albumId) : (await fetchQueueTracks(source.trackIds)).map((t) => entry(t, 'queued'));
  if (added.length === 0) return 0;
  const s = get();
  if (!s.queue || s.queue.tracks.length === 0 || s.index < 0) {
    resetForNew();
    set({ queueId: randomId(), status: 'loading' });
    begin(added, startIndex(added, null), null, { scanRequested: false, scan: null }, () => nothingPlayableMessage({ tracks: added, scanRequested: false }));
    return added.length;
  }
  editQueue((tracks, index) => insertQueued(tracks, index, added, where));
  return added.length;
}

/** Plays the queue's entry `uid` now (a row in the queue view). */
export function playEntry(uid: string) {
  const i = get().queue?.tracks.findIndex((t) => t.uid === uid) ?? -1;
  if (i >= 0) playAt(i);
}

/** Shuffle: the whole album in a random order. */
export function shuffleAlbum(album: AlbumRef): Promise<void> {
  return playAlbum(album, null, { shuffle: true });
}

export function play() {
  const s = get();
  if (remoteCtl) {
    if (!s.queue && !s.remoteDeviceId) return;
    hold('status');
    remoteCtl.send('play');
    set({ status: 'playing' });
    return;
  }
  ensureElements();
  const a = el();
  if (!s.queue || !a) return;
  // a play gesture: the DJ graph may start (or resume after a call or the lock screen)
  djGesture();
  if (s.status === 'error') { retry(); return; }
  if (sink) {
    if (!cur) { if (s.index >= 0) loadTrack(s.index, { offset: s.position }); return; }
    if (cur.completed) {
      // the queue played out on the receiver: start it over
      const first = startIndex(s.queue.tracks, null);
      if (first >= 0) { leaveCurrent(); loadTrack(first); }
      return;
    }
    set({ status: 'buffering' });
    sink.play();
    return;
  }
  // nothing loaded yet (a queue taken over from the server): from where it stopped
  if (!cur || !a.getAttribute('src')) { if (s.index >= 0) loadTrack(s.index, { offset: s.position }); return; }
  if (a.ended) {
    // the album finished: start it over
    const first = startIndex(s.queue.tracks, null);
    if (first >= 0) { leaveCurrent(); loadTrack(first); }
    return;
  }
  set({ status: a.readyState >= 3 ? 'playing' : 'buffering' });
  startPlayback(a);
}

export function pause() {
  if (remoteCtl) {
    hold('status');
    remoteCtl.send('pause');
    if (get().status !== 'idle') set({ status: 'paused' });
    return;
  }
  if (sink) {
    sink.pause();
    if (get().status !== 'error' && get().status !== 'idle') set({ status: 'paused' });
    return;
  }
  const a = el();
  if (!a) return;
  cancelMix();
  a.pause();
  if (get().status !== 'error' && get().status !== 'idle') set({ status: 'paused' });
}

export function toggle() {
  const { status } = get();
  if (status === 'playing' || status === 'buffering' || status === 'loading') pause();
  else play();
}

export function next() {
  const s = get();
  if (remoteCtl) { remoteCtl.send('next'); return; }
  if (!s.queue) return;
  const n = nextPlayable(s.queue.tracks, s.index);
  if (n < 0) return;
  leaveCurrent();
  loadTrack(n);
}

export function previous() {
  const s = get();
  if (remoteCtl) { remoteCtl.send('previous'); return; }
  if (!s.queue || s.index < 0) return;
  const action = previousAction(s.queue.tracks, s.index, s.position);
  if (action.kind === 'restart') { seek(0); if (s.status === 'paused') play(); return; }
  leaveCurrent();
  loadTrack(action.index);
}

/** Jumps to `sec` in the current track (a reload from that second for a transcode). */
export function seek(sec: number) {
  if (remoteCtl) {
    const at = Math.max(0, sec);
    hold('position');
    remoteCtl.send('seek', { value: at });
    set({ position: at });
    return;
  }
  const a = el();
  const s = get();
  if (!a || !cur) return;
  const plan = seekPlan(cur.format, sec, s.duration);
  cur.lastTime = null;
  clearHandoff();
  endRamp();
  if (sink) {
    if (plan.kind === 'native') {
      sink.seek(plan.time);
      set({ position: plan.time });
    } else {
      const track = currentTrack();
      if (!track) return;
      cur.base = plan.offset;
      set({ position: plan.offset });
      sink.load(track, { format: cur.format, offset: plan.offset, autoplay: s.status !== 'paused' });
    }
    updatePositionState();
    return;
  }
  if (plan.kind === 'native') {
    try { a.currentTime = plan.time; } catch { /* not seekable yet */ }
    set({ position: plan.time });
  } else {
    const track = currentTrack();
    if (!track) return;
    const wasPaused = a.paused && s.status !== 'loading' && s.status !== 'buffering';
    generation++;
    cur.base = plan.offset;
    set({ position: plan.offset, status: wasPaused ? 'paused' : 'buffering' });
    assignSrc(a, track.localTrackId, cur.format, plan.offset, () => { if (!wasPaused) startPlayback(a); });
  }
  updatePositionState();
}

export function setVolume(v: number) {
  const volume = Math.min(1, Math.max(0, v));
  set({ volume });
  if (remoteCtl) {
    hold('volume');
    remoteCtl.send('volume', { value: volume });
    return;
  }
  if (sink) { sink.setVolume(volume); return; }
  for (const a of elements ?? []) a.volume = volume;
}

/** Retry after an error: the same track from where it stopped, or the album's queue again. */
export function retry() {
  const s = get();
  if (s.retry === 'queue' && lastRequest) {
    const r = lastRequest;
    if (r.kind === 'album') void playAlbum(r.album, r.startTrackId, { shuffle: r.shuffle });
    else void playTracks(r.ids, r.context, { startTrackId: r.startTrackId, shuffle: r.shuffle });
    return;
  }
  if (s.queue && s.index >= 0) loadTrack(s.index, { offset: s.position, keepSession: true, ...(cur?.format && cur.triedFallback ? { format: cur.format } : {}) });
}

// ---- the queue view ----

/** Plays the queue's track `index` now (a row in the queue view). */
export function playAt(index: number) {
  const s = get();
  if (remoteCtl) {
    if (s.queue?.tracks[index]?.available) remoteCtl.send('index', { index });
    return;
  }
  const track = s.queue?.tracks[index];
  if (!track || !track.available || index === s.index) return;
  leaveCurrent();
  loadTrack(index);
}

/** Puts these tracks in the queue here, the playing one at `index`; what waits preloaded is dropped when it is no longer next. */
function replaceTracks(tracks: readonly QueueEntry[], index = get().index) {
  const s = get();
  if (!s.queue) return;
  set({ queue: { ...s.queue, tracks: [...tracks] }, index });
  const next = nextPlayable(tracks, index);
  if (preloaded && preloaded.trackId !== tracks[next]?.localTrackId) {
    clearHandoff();
    release(standby());
    preloaded = null;
  }
}

type QueueEdit = (tracks: readonly QueueEntry[], index: number) => readonly QueueEntry[];

/**
 * A change to the queue (Play next, Add to queue, reorder, remove, clear).
 * It is the person's queue, whichever device they change it on: the device
 * that plays keeps playing and picks the change up; this device takes
 * nothing over. Made from an older copy (the queue moved on elsewhere), it
 * is made again on the latest one.
 */
function editQueue(edit: QueueEdit) {
  const s = get();
  if (!s.queue) return;
  const tracks = edit(s.queue.tracks, s.index);
  if (tracks === s.queue.tracks) return;
  replaceTracks(tracks);
  void sendEdit(edit, 2);
}

async function sendEdit(edit: QueueEdit, retries: number): Promise<void> {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  const body = snapshot();
  if (!body || typeof fetch === 'undefined') return;
  try {
    const r = await api.put<{ updatedAt: string; revision: number }>('/me/player/queue', { ...body, mode: claimed ? 'save' : 'edit', revision });
    if (r?.revision) revision = r.revision;
  } catch (err) {
    if ((err as ApiError)?.status !== 409 || retries <= 0) return;
    // the queue changed elsewhere (or another device plays now): follow it, then make the change again
    await syncQueue();
    const s = get();
    if (!s.queue) return;
    const tracks = edit(s.queue.tracks, s.index);
    if (tracks !== s.queue.tracks) replaceTracks(tracks);
    await sendEdit(edit, retries - 1);
  }
}

/** Moves an upcoming track to another upcoming place. */
export function moveInQueue(from: number, to: number) {
  editQueue((tracks, index) => moveUpcoming(tracks, index, from, to));
}

/** Takes an upcoming track out of the queue. */
export function removeFromQueue(at: number) {
  editQueue((tracks, index) => removeUpcoming(tracks, index, at));
}

/** Clear: the upcoming tracks added by hand go. */
export function clearQueue() {
  editQueue((tracks, index) => clearQueued(tracks, index));
}

/**
 * Stops and clears the queue. `forget` (the bar's close) also forgets it on
 * the server; Stop from a media key, signing out or the player going away
 * leave the person's queue there for their next visit.
 */
export function stop(opts: { forget?: boolean } = {}) {
  // the receiver stops too; the cast session stays, for the next Play
  try { sink?.stop(); } catch { /* the session is gone already */ }
  clearHandoff();
  leaveCurrent();
  generation++;
  release(el());
  release(standby());
  preloaded = null;
  lastRequest = null;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  claimed = false;
  remoteCtl = null;
  if (opts.forget) {
    revision = 0;
    void api.delete('/me/player/queue').catch(() => undefined);
  }
  set({ ...initial, volume: get().volume });
  const ms = session();
  if (ms) {
    try { ms.metadata = null; ms.playbackState = 'none'; } catch { /* ignore */ }
  }
}

// ---- the queue on the server: it follows the person; a play action moves playback ----

const POSITION_SAVE_MS = 10_000;
let lastPositionSave = 0;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
/** this device plays the queue (it pressed play since it last followed another device) */
let claimed = false;
/** the server revision this device's copy is (0: none) */
let revision = 0;

function snapshot() {
  const s = get();
  if (!s.queue || s.queue.tracks.length === 0) return null;
  return {
    items: s.queue.tracks.map((t) => ({ id: t.localTrackId, origin: t.origin })),
    context: s.queue.context,
    index: s.index,
    positionMs: Math.max(0, Math.round((s.position || 0) * 1000)),
    deviceId: deviceId(),
  };
}

/**
 * The device that plays writes its place and track (mode save), or takes
 * playback (mode play: it just started playing). Fire and forget; refused
 * (409), it follows the server: another device plays now (it pauses), or the
 * queue changed elsewhere (it takes the change and plays on).
 */
function persistNow(opts: { keepalive?: boolean; mode?: 'play' | 'save' } = {}): Promise<void> {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  const snap = snapshot();
  if (!snap || typeof fetch === 'undefined') return Promise.resolve();
  const body = { ...snap, mode: opts.mode ?? 'save', ...(revision ? { revision } : {}) };
  if (opts.keepalive) {
    try {
      void fetch('/api/v1/me/player/queue', { method: 'PUT', body: JSON.stringify(body), keepalive: true, credentials: 'include', headers: { 'Content-Type': 'application/json' } }).catch(() => undefined);
    } catch { /* dropped */ }
    return Promise.resolve();
  }
  const sent = api.put<{ updatedAt: string; revision: number }>('/me/player/queue', body).then(
    (r) => { if (r?.revision && r.revision > revision) revision = r.revision; },
    (err: ApiError) => { if (err?.status === 409) void syncQueue(); },
  );
  if (body.mode === 'play') {
    // a claim on its way: what the other devices did meanwhile is read once it is in (syncQueue)
    const mine = sent.finally(() => { if (claiming === mine) claiming = null; });
    claiming = mine;
    return mine;
  }
  return sent;
}

/** The claim this device sent (PUT mode play) while it is on its way. */
let claiming: Promise<void> | null = null;

/** The device that plays writes its place a moment after a change (they come in bursts). Other devices write only edits. */
function persistSoon() {
  if (!get().queue || !claimed) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => persistNow(), 800);
}

/**
 * The page goes to the background (the phone locked, another app in front):
 * the place is written now, as a phone may freeze or end a hidden page
 * without a pagehide. While it plays hidden, timeupdate keeps saving it
 * every POSITION_SAVE_MS.
 */
export function persistOnHide() {
  if (get().queue && claimed) persistNow();
}

/** Leaving the page: the place it stopped is written while the page can still send. */
export function persistOnLeave() {
  if (get().queue && claimed) persistNow({ keepalive: true });
}

/** Drops the audio loaded here (another device plays the queue now). */
function unload() {
  try { sink?.pause(); } catch { /* the session is gone already */ }
  clearHandoff();
  leaveCurrent();
  generation++;
  release(el());
  release(standby());
  preloaded = null;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
}

/** The server's queue, paused where it is: a device that does not play. */
function adopt(view: QueueStateView) {
  revision = view.revision;
  const tracks = view.items.map((t) => entry(t, t.origin));
  if (tracks.length === 0) {
    set({ ...initial, volume: get().volume, remoteDeviceId: get().remoteDeviceId });
    return;
  }
  const index = Math.min(Math.max(view.index, 0), tracks.length - 1);
  const t = tracks[index]!;
  if (remoteCtl) {
    // showing another device: its play state and place come with its own state, not from here
    set({ queue: { context: view.context, tracks, scanRequested: false, scan: null }, queueId: get().queueId ?? randomId(), index, message: null, retry: null, loadingAlbumId: null, duration: t.durationMs ? t.durationMs / 1000 : null });
    return;
  }
  set({
    queue: { context: view.context, tracks, scanRequested: false, scan: null },
    queueId: get().queueId ?? randomId(),
    index,
    status: 'paused',
    message: null,
    retry: null,
    loadingAlbumId: null,
    position: view.positionMs / 1000,
    duration: t.durationMs ? t.durationMs / 1000 : null,
  });
  updateMetadata(t);
  setPlaybackState('paused');
}

/**
 * The device that plays takes a change made on another device: the new
 * tracks around the one playing, which plays on. When the playing track is
 * not in it any more, this device's own queue stays (its next save wins).
 */
function merge(view: QueueStateView) {
  revision = view.revision;
  const cur = currentTrack();
  const tracks = view.items.map((t) => entry(t, t.origin));
  if (!cur) { adopt(view); return; }
  let index = view.index;
  if (tracks[index]?.localTrackId !== cur.localTrackId) {
    const near = tracks.map((t, i) => (t.localTrackId === cur.localTrackId ? i : -1)).filter((i) => i >= 0)
      .sort((a, b) => Math.abs(a - view.index) - Math.abs(b - view.index));
    index = near[0] ?? -1;
  }
  if (index < 0) return;
  const s = get();
  set({ queue: { ...(s.queue ?? { scanRequested: false, scan: null }), context: view.context, tracks } });
  replaceTracks(tracks, index);
}

/** On opening tagave: the person's queue as they left it, paused where it stopped. Nothing when this device already has one. */
export async function restoreQueue(): Promise<void> {
  if (get().queue) return;
  try {
    const view = await api.get<QueueStateView>('/me/player/queue');
    if (get().queue) return;
    adopt(view);
  } catch { /* nothing to restore */ }
}

/**
 * Follows changes made on the person's other devices (on focus, every so
 * often, and after a refused write):
 *   another device pressed play      this one pauses and shows the queue there
 *   another device changed the queue the one that plays plays on with the change;
 *                                    one that does not play shows it
 * Resolves to what happened.
 */
export async function syncQueue(): Promise<'none' | 'taken' | 'merged' | 'adopted'> {
  // this device's own claim first: the server decides by arrival, and its answer says which came last
  if (claiming) await claiming;
  let stamp: QueueStampView;
  try { stamp = await api.get<QueueStampView>('/me/player/queue/stamp'); } catch { return 'none'; }
  if (!stamp || stamp.revision <= revision) return 'none';
  let view: QueueStateView;
  try { view = await api.get<QueueStateView>('/me/player/queue'); } catch { return 'none'; }
  if (view.revision <= revision) return 'none';
  const mine = view.deviceId === deviceId();
  if (claimed && !mine) {
    // another device plays now: stop here, show the queue as it is there
    claimed = false;
    unload();
    adopt(view);
    return 'taken';
  }
  if (claimed) {
    merge(view);
    return 'merged';
  }
  if (remoteCtl) {
    adopt(view);
    return 'adopted';
  }
  const s = get().status;
  if (s === 'playing' || s === 'buffering' || s === 'loading') {
    // playing here without having said so yet: the change joins what plays
    merge(view);
    return 'merged';
  }
  unload();
  adopt(view);
  return 'adopted';
}

// ---- another device plays: this one shows it and its keys control it (player/devices.ts) ----

/** Sends a key press to the device that plays (POST /me/player/command). */
export interface RemoteControl {
  send(action: PlayerCommandAction, opts?: { value?: number; index?: number }): void;
}

let remoteCtl: RemoteControl | null = null;
/** this device's own volume, kept while it shows another device's */
let localVolume: number | null = null;
/** a key pressed here: the other device's state does not move what it changed back for a moment */
const held = { status: 0, position: 0, volume: 0 };
const HOLD_MS = 1500;

function hold(what: keyof typeof held) {
  held[what] = Date.now() + HOLD_MS;
}
const isHeld = (what: keyof typeof held) => Date.now() < held[what];

/**
 * Another device plays (`remoteId`): this one shows it, and play, pause,
 * next, previous, seek, volume and a queue row go there through `control`.
 * Null: this device is on its own again.
 */
export function setRemoteControl(control: RemoteControl | null, remoteId: string | null = null) {
  if (control) {
    if (!remoteCtl) localVolume = get().volume;
    remoteCtl = control;
    if (get().remoteDeviceId !== remoteId) set({ remoteDeviceId: remoteId });
    return;
  }
  leaveRemote();
}

function leaveRemote() {
  if (!remoteCtl && !get().remoteDeviceId) return;
  remoteCtl = null;
  const volume = localVolume ?? get().volume;
  localVolume = null;
  for (const a of elements ?? []) a.volume = volume;
  set({ remoteDeviceId: null, volume });
}

/** Whether this device shows another one. */
export function isRemote(): boolean {
  return remoteCtl !== null;
}

/** Whether this device plays the queue, or has audio of its own loaded (it pressed play since it last followed another). */
export function playsHere(): boolean {
  return claimed || cur !== null;
}

/** The queue revision this device has (0: none). */
export function queueRevision(): number {
  return revision;
}

/** What the device that plays says it is doing. */
export interface RemoteState {
  index: number;
  trackId: string | null;
  /** seconds, now (interpolated by the caller) */
  position: number;
  playing: boolean;
  volume: number;
  durationMs: number | null;
}

/** The queue entry nearest `index` that holds `trackId` (the entry itself when it does), or -1. */
function entryOf(tracks: readonly QueueEntry[], index: number, trackId: string | null): number {
  if (!trackId) return index >= 0 && index < tracks.length ? index : -1;
  if (tracks[index]?.localTrackId === trackId) return index;
  const near = tracks.map((t, i) => (t.localTrackId === trackId ? i : -1)).filter((i) => i >= 0)
    .sort((a, b) => Math.abs(a - index) - Math.abs(b - index));
  return near[0] ?? -1;
}

/**
 * Shows the other device's state. Returns false when its track is not in
 * the queue this device has (the caller follows the queue then).
 */
export function mirrorRemote(m: RemoteState): boolean {
  if (!remoteCtl) return true;
  const s = get();
  const tracks = s.queue?.tracks ?? [];
  const index = entryOf(tracks, m.index, m.trackId);
  if (index < 0) return false;
  const patch: Partial<PlayerState> = {};
  if (index !== s.index) {
    patch.index = index;
    held.position = 0;
  }
  if (!isHeld('status')) {
    const status: PlayerStatus = m.playing ? 'playing' : 'paused';
    if (status !== s.status) patch.status = status;
  }
  if (!isHeld('position')) patch.position = m.position;
  const ms = m.durationMs ?? tracks[index]?.durationMs ?? null;
  const duration = ms ? ms / 1000 : null;
  if (duration !== s.duration) patch.duration = duration;
  if (!isHeld('volume') && Math.abs(m.volume - s.volume) > 0.004) patch.volume = m.volume;
  if (s.message || s.retry) { patch.message = null; patch.retry = null; }
  if (s.needsTap) patch.needsTap = false;
  set(patch);
  return true;
}

/**
 * The device that played went away (no heartbeat): this one is on its own,
 * paused where that one was last heard of. Play plays here from there.
 */
export function restAt(m: RemoteState) {
  leaveRemote();
  if (playsHere()) return;
  const s = get();
  const tracks = s.queue?.tracks ?? [];
  const at = entryOf(tracks, m.index, m.trackId);
  const index = at >= 0 ? at : s.index;
  if (index < 0) return;
  const ms = tracks[index]?.durationMs ?? null;
  set({ index, position: m.position, status: 'paused', duration: ms ? ms / 1000 : s.duration });
  setPlaybackState('paused');
}

/**
 * Playback was handed here (another device chose this one): the queue as it
 * is now, from the entry and second it was at, playing. This device plays
 * from now on, even when the browser waits for a tap first ("Tap to play
 * here").
 */
export async function takeOver(index: number, positionSec: number, opts: { autoplay?: boolean } = {}): Promise<void> {
  leaveRemote();
  let view: QueueStateView | null = null;
  try { view = await api.get<QueueStateView>('/me/player/queue'); } catch { /* the copy here, then */ }
  if (view) {
    claimed = false;
    unload();
    adopt(view);
  }
  const tracks = get().queue?.tracks ?? [];
  if (tracks.length === 0) return;
  const i = Math.min(Math.max(index, 0), tracks.length - 1);
  if (!get().queueId) set({ queueId: randomId() });
  const autoplay = opts.autoplay !== false;
  loadTrack(i, { offset: positionSec, autoplay });
  if (!autoplay) set({ needsTap: true });
  claimed = true;
  void persistNow({ mode: 'play' });
}

/**
 * Hands playback to another device: its place is written first (the other
 * device reads it from the server), then this one goes quiet. Resolves to
 * where it was, or null when nothing was loaded.
 */
export async function handOff(): Promise<{ index: number; position: number } | null> {
  const s = get();
  if (!s.queue || s.index < 0) return null;
  const at = { index: s.index, position: s.position };
  if (claimed) await persistNow();
  claimed = false;
  unload();
  if (get().status !== 'idle') set({ status: 'paused' });
  setPlaybackState('paused');
  return at;
}

/** "This device": playback comes here, from where the other device is now. */
export function playHere() {
  const s = get();
  leaveRemote();
  if (!s.queue || s.index < 0) return;
  loadTrack(s.index, { offset: s.position });
  claimed = true;
  void persistNow({ mode: 'play' });
}

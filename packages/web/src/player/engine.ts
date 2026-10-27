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
 * on. Only a play action (Play, Play from here, a skip) on another device
 * moves playback there, and this one pauses.
 */
import { create } from 'zustand';
import type { PlayEventKind, PlayerQueueView, PlayerScanStatus, QueueContext, QueueOrigin, QueueStampView, QueueStateView, QueueTrack, StreamFormat } from '@tagave/shared';
import { api, type ApiError } from '../services/api';
import {
  FAILURE_TEXT, chooseFormat, classifyFailure, clearQueued, handoffDelayMs, heardDelta, insertQueued, moveUpcoming, nextPlayable, nothingPlayableMessage, queueOrder,
  previousAction, removeUpcoming, seekPlan, shouldPreload, shownDuration, shownPosition, shuffleTracks, startContext, startIndex, streamUrl, transcodeFormat, type CanPlay,
} from './logic';
import { getPlayerQuality } from './quality';
import { isAppleMobile } from './platform';

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
}

const initial: PlayerState = { queue: null, queueId: null, index: -1, status: 'idle', message: null, retry: null, loadingAlbumId: null, position: 0, duration: null, volume: 1 };

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
/** the next track waiting in the other element */
let preloaded: { index: number; trackId: string; format: StreamFormat } | null = null;
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
}

const el = () => elements?.[active] ?? null;

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
  }
  setupMediaSession();
  return elements;
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
      // autoplay refused (no gesture yet): wait for the listener's Play
      else set({ status: 'paused' });
    });
  }
}

/** Loads the queue's track `index` into the active element. */
function loadTrack(index: number, opts: { offset?: number; format?: StreamFormat; keepSession?: boolean; autoplay?: boolean } = {}) {
  const els = ensureElements();
  const s = get();
  const track = s.queue?.tracks[index];
  if (!els || !track) return;
  generation++;
  const a = els[active]!;
  const format = opts.format ?? chooseFormat(getPlayerQuality(), track.mime, canPlayOf(a));
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
  const nextIdx = nextPlayable(s.queue!.tracks, index);
  if (preloaded && preloaded.trackId !== s.queue!.tracks[nextIdx]?.localTrackId) { release(standby()); preloaded = null; }
  set({ index, status: 'loading', message: null, retry: null, position: offset, duration: shownDuration(format, track.durationMs, Number.NaN) });
  a.src = streamUrl(track.localTrackId, format, getPlayerQuality().bitrate, offset);
  if (format === 'original' && offset > 0) {
    const seekTo = offset;
    a.addEventListener('loadedmetadata', () => { try { a.currentTime = seekTo; } catch { /* not seekable yet */ } }, { once: true });
  }
  updateMetadata(track);
  persistSoon();
  if (opts.autoplay === false) set({ status: 'paused' });
  else startPlayback(a);
}

// ---- element events ----

function onPlaying(a: HTMLAudioElement) {
  if (a !== el() || !cur) return;
  cur.lastTime = a.currentTime;
  set({ status: 'playing', message: null, retry: null });
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
  if (!preloaded && shouldPreload(position, duration)) preloadNext();
  if (preloaded && !handoffTimer) {
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
  const a = el();
  if (!a || !cur) return;
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
  if (preloaded && preloaded.trackId === tracks[next]!.localTrackId && elements) {
    const p = preloaded;
    preloaded = null;
    const old = a;
    active = 1 - active;
    const b = elements[active]!;
    generation++;
    cur = { trackId: p.trackId, index: next, format: p.format, base: 0, triedFallback: false, started: false, completed: false, heardSec: 0, lastTime: null };
    const track = tracks[next]!;
    set({ index: next, status: 'loading', message: null, retry: null, position: 0, duration: shownDuration(p.format, track.durationMs, b.duration) });
    updateMetadata(track);
    persistSoon();
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

function preloadNext() {
  const s = get();
  const b = standby();
  if (!s.queue || !b) return;
  const next = nextPlayable(s.queue.tracks, s.index);
  if (next < 0) return;
  const track = s.queue.tracks[next]!;
  const format = chooseFormat(getPlayerQuality(), track.mime, canPlayOf(b));
  preloaded = { index: next, trackId: track.localTrackId, format };
  b.preload = 'auto';
  b.src = streamUrl(track.localTrackId, format, getPlayerQuality().bitrate, 0);
  try { b.load(); } catch { /* loads on play */ }
}

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
    if (a === standby()) { preloaded = null; release(a); }
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

function randomId(): string {
  const c = globalThis.crypto;
  // randomUUID exists only in secure contexts; a homelab over plain http is not one
  if (c && typeof c.randomUUID === 'function') {
    try { return c.randomUUID(); } catch { /* fall through */ }
  }
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

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
  ensureElements();
  const a = el();
  if (!s.queue || !a) return;
  if (s.status === 'error') { retry(); return; }
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
  const a = el();
  if (!a) return;
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
  if (!s.queue) return;
  const n = nextPlayable(s.queue.tracks, s.index);
  if (n < 0) return;
  leaveCurrent();
  loadTrack(n);
}

export function previous() {
  const s = get();
  if (!s.queue || s.index < 0) return;
  const action = previousAction(s.queue.tracks, s.index, s.position);
  if (action.kind === 'restart') { seek(0); if (s.status === 'paused') play(); return; }
  leaveCurrent();
  loadTrack(action.index);
}

/** Jumps to `sec` in the current track (a reload from that second for a transcode). */
export function seek(sec: number) {
  const a = el();
  const s = get();
  if (!a || !cur) return;
  const plan = seekPlan(cur.format, sec, s.duration);
  cur.lastTime = null;
  clearHandoff();
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
    a.src = streamUrl(track.localTrackId, cur.format, getPlayerQuality().bitrate, plan.offset);
    if (!wasPaused) startPlayback(a);
  }
  updatePositionState();
}

export function setVolume(v: number) {
  const volume = Math.min(1, Math.max(0, v));
  set({ volume });
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

const DEVICE_KEY = 'tagave-player-device';
const POSITION_SAVE_MS = 10_000;
let lastPositionSave = 0;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
/** this device plays the queue (it pressed play since it last followed another device) */
let claimed = false;
/** the server revision this device's copy is (0: none) */
let revision = 0;
let deviceIdCache: string | null = null;

/** A random id for this browser, kept across visits. */
export function deviceId(): string {
  if (deviceIdCache) return deviceIdCache;
  let id: string | null = null;
  try { id = globalThis.localStorage?.getItem(DEVICE_KEY) ?? null; } catch { /* storage blocked */ }
  if (!id || id.length < 8) {
    id = randomId();
    try { globalThis.localStorage?.setItem(DEVICE_KEY, id); } catch { /* this visit only */ }
  }
  deviceIdCache = id;
  return id;
}

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
function persistNow(opts: { keepalive?: boolean; mode?: 'play' | 'save' } = {}) {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  const snap = snapshot();
  if (!snap || typeof fetch === 'undefined') return;
  const body = { ...snap, mode: opts.mode ?? 'save', ...(revision ? { revision } : {}) };
  if (opts.keepalive) {
    try {
      void fetch('/api/v1/me/player/queue', { method: 'PUT', body: JSON.stringify(body), keepalive: true, credentials: 'include', headers: { 'Content-Type': 'application/json' } }).catch(() => undefined);
    } catch { /* dropped */ }
    return;
  }
  void api.put<{ updatedAt: string; revision: number }>('/me/player/queue', body).then(
    (r) => { if (r?.revision) revision = r.revision; },
    (err: ApiError) => { if (err?.status === 409) void syncQueue(); },
  );
}

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
    set({ ...initial, volume: get().volume });
    return;
  }
  const index = Math.min(Math.max(view.index, 0), tracks.length - 1);
  const t = tracks[index]!;
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

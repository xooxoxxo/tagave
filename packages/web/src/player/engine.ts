/**
 * The web player: two plain <audio> elements kept outside React (no Web
 * Audio graph: background audio in an iOS home-screen app breaks with one),
 * a small zustand store the bar and the album page read, the play events
 * and the Media Session. The rules it applies live in logic.ts.
 *
 * One element plays; the other loads the next playable track once the
 * current one is within 30 s of its end. In the last half second a timer
 * starts the next one just before the current one ends (near-gapless where
 * the browser allows; a background tab's slowed timers fall back to the
 * `ended` swap). The queue view can reorder and remove upcoming tracks.
 * Playback is on this device only: nothing hands it to another one.
 */
import { create } from 'zustand';
import type { PlayEventKind, PlayerQueueTrack, PlayerQueueView, StreamFormat } from '@tagave/shared';
import { api, type ApiError } from '../services/api';
import {
  FAILURE_TEXT, chooseFormat, classifyFailure, handoffDelayMs, heardDelta, moveUpcoming, nextPlayable, nothingPlayableMessage, orderQueue,
  previousAction, removeUpcoming, seekPlan, shouldPreload, shownDuration, shownPosition, startIndex, streamUrl, transcodeFormat, type CanPlay,
} from './logic';
import { getPlayerQuality } from './quality';

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'buffering' | 'error';

export interface PlayerState {
  /** the album being played, its tracks in disc then track order (availability updated as streams answer) */
  queue: PlayerQueueView | null;
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
export function currentTrack(s: PlayerState = get()): PlayerQueueTrack | null {
  return s.queue?.tracks[s.index] ?? null;
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
let lastRequest: { album: AlbumRef; startTrackId: string | null } | null = null;
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

function startPlayback(a: HTMLAudioElement) {
  const p = a.play();
  if (p && typeof p.catch === 'function') {
    p.catch((err: unknown) => {
      // autoplay refused (no gesture yet): wait for the listener's Play
      if (a === el() && (err as { name?: string })?.name === 'NotAllowedError') set({ status: 'paused' });
      // AbortError: a newer load replaced this one; a failed load arrives as `error`
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
  updateMetadata(track, s.queue!);
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
    updateMetadata(track, s.queue!);
    startPlayback(b);
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

function setupMediaSession() {
  const ms = session();
  if (!ms) return;
  const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
    ['play', () => play()],
    ['pause', () => pause()],
    ['previoustrack', () => previous()],
    ['nexttrack', () => next()],
    ['stop', () => stop()],
    ['seekto', (d) => { if (d.seekTime != null) seek(d.seekTime); }],
    ['seekbackward', (d) => seek(get().position - (d.seekOffset ?? 10))],
    ['seekforward', (d) => seek(get().position + (d.seekOffset ?? 10))],
  ];
  for (const [action, handler] of handlers) {
    try { ms.setActionHandler(action, handler); } catch { /* this browser does not know the action */ }
  }
}

function artworkType(url: string): string | undefined {
  const ext = url.split('?')[0]!.split('.').pop()?.toLowerCase();
  return ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : undefined;
}

function updateMetadata(track: PlayerQueueTrack, q: PlayerQueueView) {
  const ms = session();
  if (!ms || typeof MediaMetadata === 'undefined') return;
  try {
    const artwork: MediaImage[] = [];
    if (q.coverUrl) {
      const src = new URL(q.coverUrl, globalThis.location?.href).href;
      const type = artworkType(src);
      artwork.push({ src, sizes: '512x512', ...(type ? { type } : {}) });
    }
    ms.metadata = new MediaMetadata({ title: track.title, artist: track.artist || q.albumArtist, album: q.album, artwork });
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

/** "Play" (the whole album) or "Play from here" (startTrackId). */
export async function playAlbum(album: AlbumRef, startTrackId: string | null = null): Promise<void> {
  ensureElements();
  lastRequest = { album, startTrackId };
  clearHandoff();
  leaveCurrent();
  generation++;
  release(el());
  release(standby());
  preloaded = null;
  const stub: PlayerQueueView = { albumId: album.albumId, album: album.title, albumArtist: album.artist, coverUrl: album.coverUrl, tracks: [], scanRequested: false };
  const queueId = randomId();
  set({ loadingAlbumId: album.albumId, queueId, status: 'loading', message: null, retry: null, position: 0, duration: null, queue: stub, index: -1 });
  const gen = generation;
  let view: PlayerQueueView;
  try {
    view = await api.get<PlayerQueueView>(`/player/albums/${encodeURIComponent(album.albumId)}/queue`);
  } catch (err) {
    if (gen !== generation) return;
    const status = (err as ApiError)?.status;
    set({ queue: stub, index: -1 });
    showError(status === 404 ? 'The player is not set up.' : status ? 'tagave could not load this album’s tracks. Try again.' : FAILURE_TEXT.network, 'queue');
    return;
  }
  if (gen !== generation) return;
  const ordered: PlayerQueueView = { ...view, coverUrl: view.coverUrl ?? album.coverUrl, tracks: orderQueue(view.tracks) };
  const index = startIndex(ordered.tracks, startTrackId);
  set({ queue: ordered, loadingAlbumId: null, index: index < 0 ? -1 : index });
  if (index < 0) {
    showError(nothingPlayableMessage(ordered, startTrackId ? ordered.tracks.findIndex((t) => t.localTrackId === startTrackId) : 0), 'queue');
    return;
  }
  loadTrack(index);
}

export function play() {
  const s = get();
  const a = el();
  if (!s.queue || !a) return;
  if (s.status === 'error') { retry(); return; }
  if (!cur || !a.getAttribute('src')) { if (s.index >= 0) loadTrack(s.index); return; }
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
  if (s.retry === 'queue' && lastRequest) { void playAlbum(lastRequest.album, lastRequest.startTrackId); return; }
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

function setTracks(tracks: readonly PlayerQueueTrack[]) {
  const s = get();
  if (!s.queue || tracks === s.queue.tracks) return;
  set({ queue: { ...s.queue, tracks: [...tracks] } });
  // what waits in the other element may no longer be next
  const next = nextPlayable(tracks, s.index);
  if (preloaded && preloaded.trackId !== tracks[next]?.localTrackId) {
    clearHandoff();
    release(standby());
    preloaded = null;
  }
}

/** Moves an upcoming track to another upcoming place. */
export function moveInQueue(from: number, to: number) {
  const s = get();
  if (s.queue) setTracks(moveUpcoming(s.queue.tracks, s.index, from, to));
}

/** Takes an upcoming track out of the queue. */
export function removeFromQueue(at: number) {
  const s = get();
  if (s.queue) setTracks(removeUpcoming(s.queue.tracks, s.index, at));
}

/** Stops and clears the queue (the bar's close, Stop from a media key, signing out). */
export function stop() {
  clearHandoff();
  leaveCurrent();
  generation++;
  release(el());
  release(standby());
  preloaded = null;
  lastRequest = null;
  set({ ...initial, volume: get().volume });
  const ms = session();
  if (ms) {
    try { ms.metadata = null; ms.playbackState = 'none'; } catch { /* ignore */ }
  }
}

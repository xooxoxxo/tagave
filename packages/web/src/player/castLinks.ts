/**
 * Casting's shared state and the links a cast device fetches.
 *
 * A Chromecast, an AirPlay speaker or an Apple TV fetches the audio itself,
 * without this browser's session cookie, so it gets a signed link instead
 * (POST /api/v1/player/cast-url): one track, this person, about six hours,
 * on PUBLIC_URL. Links are kept until ten minutes before they expire, so a
 * track change or a click on the cast key can use one at once.
 *
 * The answer also says whether PUBLIC_URL looks reachable from a cast device
 * (`reach`); the cast key reads it from the store.
 */
import { create } from 'zustand';
import type { CastReach, CastUrlView, StreamFormat } from '@tagave/shared';
import { api } from '../services/api';

/** How this browser casts: AirPlay (Safari), the Remote Playback API (Chrome on Android) or the Cast SDK (Chrome on a desktop). */
export type CastKind = 'airplay' | 'remote' | 'cast';

export interface CastState {
  kind: CastKind | null;
  /** a device is there to cast to */
  available: boolean;
  state: 'off' | 'connecting' | 'on';
  /** the device's name, when the platform tells it (the Cast SDK does; AirPlay and Remote Playback do not) */
  device: string | null;
  /** PUBLIC_URL as a cast device sees it (from the last link), and its host */
  reach: CastReach | null;
  host: string | null;
}

export const initialCast: CastState = { kind: null, available: false, state: 'off', device: null, reach: null, host: null };
export const useCastStore = create<CastState>()(() => ({ ...initialCast }));

/** Casting right now (connecting counts: the music is on its way there). */
export function isCasting(s: CastState = useCastStore.getState()): boolean {
  return s.state !== 'off';
}

const KEEP_UNTIL_MS = 10 * 60_000;
const cache = new Map<string, { view: CastUrlView; until: number }>();
const inflight = new Map<string, Promise<CastUrlView>>();
const failed = new Map<string, number>();
const RETRY_AFTER_MS = 30_000;
const keyOf = (trackId: string, format: StreamFormat, bitrate: number) => `${trackId}|${format}|${format === 'original' ? 0 : bitrate}`;

function note(view: CastUrlView) {
  let host: string | null = null;
  try { host = view.url ? new URL(view.url).host : null; } catch { /* not a URL */ }
  const s = useCastStore.getState();
  if (s.reach !== view.reach || s.host !== host) useCastStore.setState({ reach: view.reach, host });
}

/** A link from the cache, still good for ten minutes, or null. */
export function cachedCastLink(trackId: string, format: StreamFormat, bitrate: number, now = Date.now()): CastUrlView | null {
  const hit = cache.get(keyOf(trackId, format, bitrate));
  return hit && hit.until > now ? hit.view : null;
}

/** A link for this track (from the cache when it is still good). */
export function fetchCastLink(trackId: string, format: StreamFormat, bitrate: number): Promise<CastUrlView> {
  const key = keyOf(trackId, format, bitrate);
  const hit = cachedCastLink(trackId, format, bitrate);
  if (hit) return Promise.resolve(hit);
  const running = inflight.get(key);
  if (running) return running;
  // a refused link is not asked for again at once (the player's ticks would)
  if ((failed.get(key) ?? 0) > Date.now()) return Promise.reject(new Error('cast link refused a moment ago'));
  const body = { localTrackId: trackId, format, ...(format === 'original' ? {} : { maxBitRate: bitrate }) };
  const p = api.post<CastUrlView>('/player/cast-url', body).then((view) => {
    cache.set(key, { view, until: Date.parse(view.expiresAt) - KEEP_UNTIL_MS });
    if (cache.size > 64) cache.delete(cache.keys().next().value!);
    failed.delete(key);
    note(view);
    return view;
  }, (err: unknown) => {
    failed.set(key, Date.now() + RETRY_AFTER_MS);
    throw err;
  }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/**
 * The URL an element (or the receiver) loads: the link, plus the second a
 * transcode starts at. On the page's own origin it stays relative, so the
 * glow's analyser can still read the sound (a copy from another origin is
 * silent to it).
 */
export function castSrc(view: CastUrlView, format: StreamFormat, offsetSec = 0, origin: string | null | undefined = globalThis.location?.origin): string | null {
  if (!view.url) return null;
  const u = new URL(view.url);
  const offset = Math.max(0, Math.floor(offsetSec));
  if (format !== 'original' && offset > 0) u.searchParams.set('offset', String(offset));
  return origin && u.origin === origin ? `${u.pathname}${u.search}` : u.href;
}

/**
 * When a play counts. Last.fm's rule, which ListenBrainz follows too: the
 * track is longer than 30 seconds and was heard for half its length or for
 * four minutes, whichever comes first. tagave's album listens use the same
 * "heard" half without the 30-second floor, so a short interlude still
 * counts towards an album.
 */
export const MIN_SCROBBLE_TRACK_MS = 30_000;
export const HEARD_ENOUGH_MS = 4 * 60_000;
/** Last.fm drops scrobbles older than this. */
export const MAX_SCROBBLE_AGE_MS = 14 * 24 * 3600_000;

export function heardEnough(playedMs: number, durationMs: number | null): boolean {
  if (playedMs >= HEARD_ENOUGH_MS) return true;
  if (!durationMs || durationMs <= 0) return false;
  return playedMs >= durationMs / 2;
}

export function scrobbleWorthy(playedMs: number, durationMs: number | null): boolean {
  if (durationMs != null && durationMs > 0 && durationMs <= MIN_SCROBBLE_TRACK_MS) return false;
  return heardEnough(playedMs, durationMs);
}

/** A track as both services want it. */
export interface ScrobbleTrack {
  artist: string;
  track: string;
  album: string | null;
  albumArtist: string | null;
  trackNumber: number | null;
  durationMs: number | null;
  recordingMbid: string | null;
  releaseMbid: string | null;
}

/** Retry after 1, 2, 4 … minutes, at most six hours apart. */
export function retryDelayMs(attempts: number): number {
  return Math.min(6 * 3600_000, 60_000 * 2 ** Math.max(0, attempts - 1));
}

/** The outcome of one send, the same for both services. */
export type SendOutcome =
  | { kind: 'sent' }
  /** the service took the request and said it will not keep it (too old, a filtered artist): never retried */
  | { kind: 'ignored'; reason: string }
  /** the session or token no longer works: the person has to connect again */
  | { kind: 'auth'; reason: string }
  /** try again later (network, rate limit, the service is down) */
  | { kind: 'retry'; reason: string }
  /** a request the service will never take */
  | { kind: 'failed'; reason: string };

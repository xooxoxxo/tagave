/**
 * ListenBrainz: each person pastes their user token (listenbrainz.org ›
 * Settings › User token). tagave checks it with /1/validate-token and sends
 * listens with /1/submit-listens. The recording MBID tagave wrote into the
 * file goes along, so ListenBrainz links the exact recording.
 * https://listenbrainz.readthedocs.io/en/latest/users/api/core.html
 */
import type { ScrobbleTrack, SendOutcome } from './rules.js';

export const LISTENBRAINZ_API_URL = 'https://api.listenbrainz.org';
export const LISTENBRAINZ_TOKEN_URL = 'https://listenbrainz.org/settings/';

type Opts = { fetchImpl?: typeof fetch; timeoutMs?: number; apiUrl?: string };

const base = (opts: Opts) => (opts.apiUrl ?? LISTENBRAINZ_API_URL).replace(/\/+$/, '');

/** The token's owner, or null when ListenBrainz says the token is not valid. */
export async function listenbrainzValidate(token: string, opts: Opts = {}): Promise<string | null> {
  const res = await (opts.fetchImpl ?? fetch)(`${base(opts)}/1/validate-token`, {
    headers: { authorization: `Token ${token}` },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
  });
  const body = (await res.json().catch(() => null)) as { valid?: boolean; user_name?: string } | null;
  if (res.status >= 500 || !body) throw new Error(`ListenBrainz answered ${res.status}`);
  return body.valid && body.user_name ? body.user_name : null;
}

function metadata(t: ScrobbleTrack) {
  const additional: Record<string, unknown> = { media_player: 'tagave', submission_client: 'tagave' };
  if (t.recordingMbid) additional['recording_mbid'] = t.recordingMbid;
  if (t.releaseMbid) additional['release_mbid'] = t.releaseMbid;
  if (t.durationMs) additional['duration_ms'] = Math.round(t.durationMs);
  if (t.trackNumber) additional['tracknumber'] = t.trackNumber;
  return {
    artist_name: t.artist,
    track_name: t.track,
    ...(t.album ? { release_name: t.album } : {}),
    additional_info: additional,
  };
}

async function submit(token: string, body: unknown, opts: Opts): Promise<SendOutcome> {
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(`${base(opts)}/1/submit-listens`, {
      method: 'POST',
      headers: { authorization: `Token ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
  } catch (err) {
    return { kind: 'retry', reason: `ListenBrainz could not be reached (${(err as Error).message})` };
  }
  if (res.ok) return { kind: 'sent' };
  const answer = (await res.json().catch(() => null)) as { error?: string } | null;
  const why = answer?.error ?? `ListenBrainz answered ${res.status}`;
  if (res.status === 401) return { kind: 'auth', reason: 'ListenBrainz no longer accepts this token; paste a new one' };
  if (res.status === 429 || res.status >= 500) return { kind: 'retry', reason: why };
  return { kind: 'failed', reason: why };
}

export function listenbrainzScrobble(token: string, track: ScrobbleTrack, startedAt: Date, opts: Opts = {}): Promise<SendOutcome> {
  return submit(token, { listen_type: 'single', payload: [{ listened_at: Math.floor(startedAt.getTime() / 1000), track_metadata: metadata(track) }] }, opts);
}

export function listenbrainzNowPlaying(token: string, track: ScrobbleTrack, opts: Opts = {}): Promise<SendOutcome> {
  return submit(token, { listen_type: 'playing_now', payload: [{ track_metadata: metadata(track) }] }, opts);
}

/**
 * Last.fm, as an "application" the owner registers once (API key + shared
 * secret). Each person authorises tagave in their browser (web auth: Last.fm
 * sends them back with a token) and tagave trades the token for a session
 * key that does not expire until they revoke it.
 *
 * Every write is signed: api_sig = md5 of the parameters sorted by name,
 * each name followed by its value, then the shared secret.
 * https://www.last.fm/api/authspec, https://www.last.fm/api/scrobbling
 */
import { createHash } from 'node:crypto';
import type { ScrobbleTrack, SendOutcome } from './rules.js';

export const LASTFM_API_URL = 'https://ws.audioscrobbler.com/2.0/';
export const LASTFM_AUTH_URL = 'https://www.last.fm/api/auth/';
export const LASTFM_CREATE_APP_URL = 'https://www.last.fm/api/account/create';

export interface LastfmApp {
  apiKey: string;
  secret: string;
  /** for tests: a fake Last.fm */
  apiUrl?: string;
  authUrl?: string;
}

type Opts = { fetchImpl?: typeof fetch; timeoutMs?: number };

export function lastfmSignature(params: Record<string, string>, secret: string): string {
  const base = Object.keys(params)
    .filter((k) => k !== 'format' && k !== 'callback')
    .sort()
    .map((k) => `${k}${params[k]}`)
    .join('');
  return createHash('md5').update(base + secret, 'utf8').digest('hex');
}

/** Where the person's browser goes to allow tagave; Last.fm comes back to `callbackUrl` with ?token=. */
export function lastfmAuthorizeUrl(app: LastfmApp, callbackUrl: string): string {
  const q = new URLSearchParams({ api_key: app.apiKey, cb: callbackUrl });
  return `${app.authUrl ?? LASTFM_AUTH_URL}?${q.toString()}`;
}

interface LastfmAnswer {
  error?: number;
  message?: string;
  session?: { name?: string; key?: string };
  scrobbles?: { '@attr'?: { accepted?: number | string; ignored?: number | string }; scrobble?: { ignoredMessage?: { code?: string | number; '#text'?: string } } | Array<{ ignoredMessage?: { code?: string | number; '#text'?: string } }> };
  nowplaying?: unknown;
}

async function call(app: LastfmApp, params: Record<string, string>, opts: Opts): Promise<{ status: number; body: LastfmAnswer | null }> {
  const signed = { ...params, api_key: app.apiKey };
  const form = new URLSearchParams({ ...signed, api_sig: lastfmSignature(signed, app.secret), format: 'json' });
  const res = await (opts.fetchImpl ?? fetch)(app.apiUrl ?? LASTFM_API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'tagave (self-hosted music catalogue)' },
    body: form.toString(),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
  });
  const body = (await res.json().catch(() => null)) as LastfmAnswer | null;
  return { status: res.status, body };
}

/** Last.fm error codes: 9 bad session, 4/14/15 token problems, 10/26 bad key, 11/16 down, 29 rate limit. */
function outcomeOf(status: number, body: LastfmAnswer | null): SendOutcome | null {
  const code = body?.error;
  const why = body?.message ?? `Last.fm answered ${status}`;
  if (code === 9) return { kind: 'auth', reason: 'Last.fm no longer accepts this connection; connect again' };
  if (code === 10 || code === 26) return { kind: 'auth', reason: `The Last.fm API key was refused (${why})` };
  if (code === 11 || code === 16 || code === 29 || status === 429 || status >= 500) return { kind: 'retry', reason: why };
  if (code != null) return { kind: 'failed', reason: why };
  if (status >= 400 || !body) return { kind: 'retry', reason: why };
  return null;
}

/**
 * Checks the API key and the shared secret together: auth.getToken is a
 * signed call, so a wrong secret fails it (13, invalid signature) as surely
 * as a wrong key (10).
 */
export async function lastfmCheckApp(app: LastfmApp, opts: Opts = {}): Promise<{ ok: true } | { ok: false; reason: string }> {
  let answer: { status: number; body: LastfmAnswer | null };
  try {
    answer = await call(app, { method: 'auth.getToken' }, opts);
  } catch (err) {
    return { ok: false, reason: `Last.fm could not be reached (${(err as Error).message})` };
  }
  const code = answer.body?.error;
  if (code === 10 || code === 26) return { ok: false, reason: 'Last.fm does not know this API key' };
  if (code === 13) return { ok: false, reason: 'The shared secret does not belong to this API key' };
  if (code != null) return { ok: false, reason: answer.body?.message ?? `Last.fm answered with error ${code}` };
  if (answer.status >= 400) return { ok: false, reason: `Last.fm answered ${answer.status}` };
  return { ok: true };
}

/** auth.getSession: the token from the callback for a session key and the person's Last.fm name. */
export async function lastfmSession(app: LastfmApp, token: string, opts: Opts = {}): Promise<{ name: string; key: string }> {
  const { status, body } = await call(app, { method: 'auth.getSession', token }, opts);
  if (body?.session?.key && body.session.name) return { name: body.session.name, key: body.session.key };
  throw new Error(body?.message ? `Last.fm: ${body.message}` : `Last.fm answered ${status}`);
}

function trackParams(t: ScrobbleTrack): Record<string, string> {
  const p: Record<string, string> = { artist: t.artist, track: t.track };
  if (t.album) p['album'] = t.album;
  if (t.albumArtist && t.albumArtist !== t.artist) p['albumArtist'] = t.albumArtist;
  if (t.trackNumber) p['trackNumber'] = String(t.trackNumber);
  if (t.durationMs) p['duration'] = String(Math.round(t.durationMs / 1000));
  if (t.recordingMbid) p['mbid'] = t.recordingMbid;
  return p;
}

export async function lastfmScrobble(app: LastfmApp, sessionKey: string, track: ScrobbleTrack, startedAt: Date, opts: Opts = {}): Promise<SendOutcome> {
  let answer: { status: number; body: LastfmAnswer | null };
  try {
    answer = await call(app, { method: 'track.scrobble', sk: sessionKey, timestamp: String(Math.floor(startedAt.getTime() / 1000)), ...trackParams(track) }, opts);
  } catch (err) {
    return { kind: 'retry', reason: `Last.fm could not be reached (${(err as Error).message})` };
  }
  const bad = outcomeOf(answer.status, answer.body);
  if (bad) return bad;
  const attr = answer.body?.scrobbles?.['@attr'];
  if (attr && Number(attr.ignored ?? 0) > 0 && Number(attr.accepted ?? 0) === 0) {
    const s = answer.body?.scrobbles?.scrobble;
    const msg = (Array.isArray(s) ? s[0] : s)?.ignoredMessage;
    return { kind: 'ignored', reason: msg?.['#text'] || `Last.fm ignored it (code ${msg?.code ?? '?'})` };
  }
  return { kind: 'sent' };
}

/** Last.fm takes up to 50 scrobbles in one track.scrobble call. */
export const LASTFM_BATCH_MAX = 50;

/** A play to scrobble: the track and when it started. */
export interface TimedTrack {
  track: ScrobbleTrack;
  startedAt: Date;
}

type IgnoredMessage = { code?: string | number; '#text'?: string };

/**
 * Up to 50 scrobbles in one signed call (artist[0], track[0], timestamp[0],
 * …), so a backlog is one request, not fifty. One outcome per item, in the
 * same order: a problem with the call (offline, rate limit, a session that
 * no longer works) applies to all of them; Last.fm ignoring one item (too
 * old, a filtered artist) applies to that item only.
 */
export async function lastfmScrobbleBatch(app: LastfmApp, sessionKey: string, items: TimedTrack[], opts: Opts = {}): Promise<SendOutcome[]> {
  if (items.length === 0) return [];
  if (items.length > LASTFM_BATCH_MAX) throw new RangeError(`Last.fm takes at most ${LASTFM_BATCH_MAX} scrobbles per call`);
  if (items.length === 1) return [await lastfmScrobble(app, sessionKey, items[0]!.track, items[0]!.startedAt, opts)];
  const params: Record<string, string> = { method: 'track.scrobble', sk: sessionKey };
  items.forEach((it, i) => {
    const one = { timestamp: String(Math.floor(it.startedAt.getTime() / 1000)), ...trackParams(it.track) };
    for (const [k, v] of Object.entries(one)) params[`${k}[${i}]`] = v;
  });
  let answer: { status: number; body: LastfmAnswer | null };
  try {
    answer = await call(app, params, opts);
  } catch (err) {
    const reason = `Last.fm could not be reached (${(err as Error).message})`;
    return items.map(() => ({ kind: 'retry', reason }));
  }
  const bad = outcomeOf(answer.status, answer.body);
  if (bad) return items.map(() => bad);
  const s = answer.body?.scrobbles?.scrobble;
  const each: Array<{ ignoredMessage?: IgnoredMessage }> = Array.isArray(s) ? s : s ? [s] : [];
  return items.map((_, i): SendOutcome => {
    const msg = each[i]?.ignoredMessage;
    if (msg?.code != null && String(msg.code) !== '0') return { kind: 'ignored', reason: msg['#text'] || `Last.fm ignored it (code ${msg.code})` };
    return { kind: 'sent' };
  });
}

export async function lastfmNowPlaying(app: LastfmApp, sessionKey: string, track: ScrobbleTrack, opts: Opts = {}): Promise<SendOutcome> {
  try {
    const answer = await call(app, { method: 'track.updateNowPlaying', sk: sessionKey, ...trackParams(track) }, opts);
    return outcomeOf(answer.status, answer.body) ?? { kind: 'sent' };
  } catch (err) {
    return { kind: 'retry', reason: (err as Error).message };
  }
}

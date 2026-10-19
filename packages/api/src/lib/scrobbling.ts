/**
 * Scrobbling: tagave sends every scrobble itself, for plays from its own web
 * player and for plays from other apps that it reads back from the player
 * server. The player server never scrobbles (the bundled Navidrome runs with
 * its Last.fm and ListenBrainz integrations off), so each play reaches each
 * service from one place only.
 *
 * Exactly once, step by step:
 *  1. a play is one player_plays row, unique per person and dedupe key, so
 *     seeing the same play twice changes nothing (playerPlays.ts);
 *  2. a play gets one player_scrobbles row per service (primary key
 *     play_id + service, inserted with on conflict do nothing);
 *  3. a sender claims due rows with FOR UPDATE SKIP LOCKED and marks them
 *     'sending' in the same statement, so two senders never take one row;
 *     only a row stuck in 'sending' for 10 minutes (a crash mid-request) is
 *     taken again, the one case where a service may see a play twice, which
 *     both de-duplicate by track and timestamp.
 *
 * Secrets: the owner's Last.fm API key and shared secret live sealed in the
 * library settings (or TAGAVE_LASTFM_API_KEY / TAGAVE_LASTFM_SECRET in
 * .env); each person's Last.fm session key and ListenBrainz token live
 * sealed in scrobble_accounts. None of them ever reaches a browser.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type postgres from 'postgres';
import { computeHint, openSecret, sealSecret } from '@tagave/core';
import {
  LASTFM_BATCH_MAX,
  MAX_SCROBBLE_AGE_MS,
  lastfmNowPlaying,
  lastfmScrobbleBatch,
  listenbrainzNowPlaying,
  listenbrainzScrobbleBatch,
  retryDelayMs,
  type LastfmApp,
  type ScrobbleTrack,
  type SendOutcome,
  type TimedTrack,
} from '@tagave/core/scrobble';
import type { ScrobbleAccountView, ScrobbleService, ScrobblingSettingsView } from '@tagave/shared';
import { appSecret } from './playerPeople.js';
import { parseSettings } from './player.js';

type Sql = postgres.Sql;

export const SCROBBLE_SERVICES: ScrobbleService[] = ['lastfm', 'listenbrainz'];
const MAX_ATTEMPTS = 12;
const STUCK_SENDING_MS = 10 * 60_000;

export interface ScrobbleDeps {
  sql: Sql;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  log?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
}

// -- the owner's Last.fm application ---------------------------------------------

export interface LastfmAppSettings {
  lastfmApiKey?: unknown;
  lastfmSecret?: unknown;
  lastfmApiKeyHint?: unknown;
}

function testUrls(env: NodeJS.ProcessEnv): Pick<LastfmApp, 'apiUrl' | 'authUrl'> {
  // only for tests and the end-to-end check: a fake Last.fm
  const apiUrl = env['TAGAVE_LASTFM_API_URL']?.trim();
  const authUrl = env['TAGAVE_LASTFM_AUTH_URL']?.trim();
  return { ...(apiUrl ? { apiUrl } : {}), ...(authUrl ? { authUrl } : {}) };
}

export function listenbrainzUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env['TAGAVE_LISTENBRAINZ_API_URL']?.trim() || undefined;
}

/** The Last.fm application from the library's settings, else from .env; null when neither is set. */
export function lastfmAppFrom(settings: LastfmAppSettings | null | undefined, env: NodeJS.ProcessEnv = process.env): { app: LastfmApp; source: 'settings' | 'env'; hint: string | null } | null {
  const s = settings ?? {};
  if (typeof s.lastfmApiKey === 'string' && typeof s.lastfmSecret === 'string' && s.lastfmApiKey && s.lastfmSecret) {
    try {
      const apiKey = openSecret(s.lastfmApiKey, appSecret());
      const secret = openSecret(s.lastfmSecret, appSecret());
      return { app: { apiKey, secret, ...testUrls(env) }, source: 'settings', hint: typeof s.lastfmApiKeyHint === 'string' ? s.lastfmApiKeyHint : computeHint(apiKey) };
    } catch {
      return null;
    }
  }
  const apiKey = env['TAGAVE_LASTFM_API_KEY']?.trim();
  const secret = env['TAGAVE_LASTFM_SECRET']?.trim();
  if (apiKey && secret) return { app: { apiKey, secret, ...testUrls(env) }, source: 'env', hint: computeHint(apiKey) };
  return null;
}

/**
 * The install's Last.fm application. It is one per install, kept in a
 * library's settings: the named library's when it has one, else the first
 * library that does, else .env.
 */
export async function installLastfmApp(sql: Sql, env: NodeJS.ProcessEnv = process.env, libraryId?: string | null): Promise<LastfmApp | null> {
  const rows = await sql<{ settings: unknown }[]>`
    select settings from libraries where settings ? 'lastfmApiKey'
    order by (id = ${libraryId ?? null}::uuid) desc nulls last, created_at`;
  for (const r of rows) {
    const found = lastfmAppFrom(parseSettings(r.settings) as LastfmAppSettings, env);
    if (found?.source === 'settings') return found.app;
  }
  return lastfmAppFrom({}, env)?.app ?? null;
}

export function scrobblingSettingsView(settings: LastfmAppSettings, env: NodeJS.ProcessEnv = process.env): ScrobblingSettingsView {
  const found = lastfmAppFrom(settings, env);
  return { lastfm: { configured: !!found, source: found?.source ?? null, apiKeyHint: found?.hint ?? null }, listenbrainz: { available: true } };
}

export function sealLastfmApp(apiKey: string, secret: string): Required<LastfmAppSettings> {
  return { lastfmApiKey: sealSecret(apiKey, appSecret()), lastfmSecret: sealSecret(secret, appSecret()), lastfmApiKeyHint: computeHint(apiKey) };
}

// -- the Last.fm web-auth round trip -----------------------------------------------------

const STATE_TTL_MS = 15 * 60_000;

/** A signed, short-lived value naming the person, carried through Last.fm and back. */
export function lastfmState(userId: string, now = Date.now()): string {
  const exp = String(now + STATE_TTL_MS);
  const sig = createHmac('sha256', appSecret()).update(`lastfm-connect|${userId}|${exp}`).digest('base64url');
  return `${exp}.${sig}`;
}

export function checkLastfmState(state: string | undefined, userId: string, now = Date.now()): boolean {
  if (!state) return false;
  const [exp, sig] = state.split('.');
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < now) return false;
  const want = createHmac('sha256', appSecret()).update(`lastfm-connect|${userId}|${exp}`).digest();
  const got = Buffer.from(sig, 'base64url');
  return got.length === want.length && timingSafeEqual(got, want);
}

export function publicOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env['PUBLIC_URL']?.trim();
  if (!raw) return null;
  try { return new URL(raw).origin; } catch { return null; }
}

// -- each person's accounts ----------------------------------------------------------------

interface AccountRow {
  service: ScrobbleService;
  account_name: string;
  secret_sealed: string;
  connected_at: Date;
  last_ok_at: Date | null;
  last_error: string | null;
  last_error_at: Date | null;
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

export async function accountViews(sql: Sql, userId: string): Promise<ScrobbleAccountView[]> {
  const rows = await sql<AccountRow[]>`
    select service, account_name, secret_sealed, connected_at, last_ok_at, last_error, last_error_at
    from scrobble_accounts where user_id = ${userId}`;
  const pending = await sql<{ service: ScrobbleService; n: number }[]>`
    select s.service, count(*)::int as n from player_scrobbles s join player_plays p on p.id = s.play_id
    where p.user_id = ${userId} and s.status in ('pending', 'sending') group by s.service`;
  return SCROBBLE_SERVICES.map((service) => {
    const r = rows.find((x) => x.service === service);
    return {
      service,
      connected: !!r,
      accountName: r?.account_name ?? null,
      connectedAt: iso(r?.connected_at),
      lastOkAt: iso(r?.last_ok_at),
      lastError: r?.last_error ?? null,
      lastErrorAt: iso(r?.last_error_at),
      pending: r ? pending.find((p) => p.service === service)?.n ?? 0 : 0,
    };
  });
}

/**
 * Connects (or reconnects) a person's account and queues their recent plays
 * that never went to this service. Returns how many were queued.
 */
export async function connectAccount(sql: Sql, userId: string, service: ScrobbleService, accountName: string, secret: string, now = Date.now()): Promise<number> {
  await sql`
    insert into scrobble_accounts (user_id, service, account_name, secret_sealed)
    values (${userId}, ${service}, ${accountName}, ${sealSecret(secret, appSecret())})
    on conflict (user_id, service) do update set account_name = excluded.account_name, secret_sealed = excluded.secret_sealed,
      connected_at = now(), last_error = null, last_error_at = null`;
  // scrobbles that waited for a working connection go now
  await sql`
    update player_scrobbles s set next_attempt_at = now()
    from player_plays p where p.id = s.play_id and p.user_id = ${userId} and s.service = ${service} and s.status = 'pending'`;
  return backfillScrobbles(sql, userId, service, now);
}

/**
 * Plays from before the person connected: queued once, on connect. Last.fm
 * drops scrobbles older than 14 days, so the window is 14 days for both
 * services (ListenBrainz would take older ones; one rule is simpler).
 *
 * A play is queued when it is the person's own, counted as a scrobble
 * (player_plays.scrobbles: the 30-second / half-or-four-minutes rule, the
 * same flag that queues a new play), started within the last 14 days, has
 * an artist and a title (the sender fails a play without them), and has no
 * row for this service yet: a play that was already sent, ignored, or
 * dropped by an earlier disconnect is not queued again. Nothing is queued
 * while the person's own server scrobbles for them.
 */
export async function backfillScrobbles(sql: Sql, userId: string, service: ScrobbleService, now = Date.now()): Promise<number> {
  const since = new Date(now - MAX_SCROBBLE_AGE_MS).toISOString();
  const rows = await sql<{ play_id: string }[]>`
    insert into player_scrobbles (play_id, service)
    select p.id, ${service} from player_plays p
    where p.user_id = ${userId} and p.scrobbles and p.started_at > ${since}
      and p.artist is not null and p.artist <> '' and p.title <> ''
      and not exists (select 1 from player_users u where u.user_id = p.user_id and u.state = 'active' and u.server_scrobbles)
    order by p.started_at
    on conflict (play_id, service) do nothing
    returning play_id`;
  return rows.length;
}

/** Disconnecting drops what was still waiting for that service: it is not sent later. */
export async function disconnectAccount(sql: Sql, userId: string, service: ScrobbleService): Promise<void> {
  await sql`delete from scrobble_accounts where user_id = ${userId} and service = ${service}`;
  await sql`
    update player_scrobbles s set status = 'failed', last_error = 'Disconnected before it was sent'
    from player_plays p where p.id = s.play_id and p.user_id = ${userId} and s.service = ${service} and s.status in ('pending', 'sending')`;
}

/** Which services a new play of this person goes to (none when their own server scrobbles for them). */
export async function servicesFor(sql: Sql, userId: string): Promise<ScrobbleService[]> {
  const rows = await sql<{ service: ScrobbleService }[]>`select service from scrobble_accounts where user_id = ${userId}`;
  return rows.map((r) => r.service);
}

/** Queues the play for each service the person connected; a second call for the same play adds nothing. */
export async function enqueueScrobbles(sql: Sql, playId: string, services: ScrobbleService[]): Promise<void> {
  if (services.length === 0) return;
  await sql`
    insert into player_scrobbles (play_id, service)
    select ${playId}::uuid, s from unnest(${services}::text[]) as s
    on conflict (play_id, service) do nothing`;
}

// -- sending ----------------------------------------------------------------------------------

interface DueRow {
  play_id: string;
  service: ScrobbleService;
  attempts: number;
  user_id: string;
  library_id: string | null;
  title: string;
  artist: string | null;
  album: string | null;
  album_artist: string | null;
  track_no: number | null;
  duration_ms: number | null;
  recording_mbid: string | null;
  release_mbid: string | null;
  started_at: Date;
}

export function scrobbleTrackOf(r: Pick<DueRow, 'title' | 'artist' | 'album' | 'album_artist' | 'track_no' | 'duration_ms' | 'recording_mbid' | 'release_mbid'>): ScrobbleTrack | null {
  if (!r.artist || !r.title) return null;
  return {
    artist: r.artist,
    track: r.title,
    album: r.album,
    albumArtist: r.album_artist,
    trackNumber: r.track_no,
    durationMs: r.duration_ms,
    recordingMbid: r.recording_mbid,
    releaseMbid: r.release_mbid,
  };
}

/** Takes due scrobbles for sending: due pending ones, and ones stuck mid-send after a crash. */
async function claim(sql: Sql, limit: number, now: Date): Promise<DueRow[]> {
  const stuck = new Date(now.getTime() - STUCK_SENDING_MS);
  return sql<DueRow[]>`
    with due as (
      select s.play_id, s.service from player_scrobbles s
      where (s.status = 'pending' and s.next_attempt_at <= greatest(${now.toISOString()}::timestamptz, now()))
         or (s.status = 'sending' and s.claimed_at < ${stuck.toISOString()})
      order by s.next_attempt_at
      limit ${limit}
      for update skip locked
    )
    update player_scrobbles s set status = 'sending', claimed_at = ${now.toISOString()}, attempts = s.attempts + 1
    from due, player_plays p
    where s.play_id = due.play_id and s.service = due.service and p.id = s.play_id
    returning s.play_id, s.service, s.attempts, p.user_id, p.library_id, p.title, p.artist, p.album, p.album_artist,
              p.track_no, p.duration_ms, p.recording_mbid, p.release_mbid, p.started_at`;
}

async function settle(sql: Sql, row: DueRow, outcome: SendOutcome, now: Date): Promise<void> {
  switch (outcome.kind) {
    case 'sent':
      await sql`update player_scrobbles set status = 'sent', sent_at = ${now.toISOString()}, last_error = null where play_id = ${row.play_id} and service = ${row.service}`;
      await sql`update scrobble_accounts set last_ok_at = ${now.toISOString()}, last_error = null, last_error_at = null where user_id = ${row.user_id} and service = ${row.service}`;
      return;
    case 'ignored':
      await sql`update player_scrobbles set status = 'ignored', last_error = ${outcome.reason} where play_id = ${row.play_id} and service = ${row.service}`;
      return;
    case 'failed':
      await sql`update player_scrobbles set status = 'failed', last_error = ${outcome.reason} where play_id = ${row.play_id} and service = ${row.service}`;
      await sql`update scrobble_accounts set last_error = ${outcome.reason}, last_error_at = ${now.toISOString()} where user_id = ${row.user_id} and service = ${row.service}`;
      return;
    case 'auth':
    case 'retry': {
      const giveUp = row.attempts >= MAX_ATTEMPTS || now.getTime() - new Date(row.started_at).getTime() > MAX_SCROBBLE_AGE_MS;
      // a connection that no longer works waits for the person to connect again (connectAccount wakes it)
      const wait = outcome.kind === 'auth' ? 24 * 3600_000 : retryDelayMs(row.attempts);
      await sql`
        update player_scrobbles set status = ${giveUp ? 'failed' : 'pending'}, last_error = ${outcome.reason},
          next_attempt_at = ${new Date(now.getTime() + wait).toISOString()}
        where play_id = ${row.play_id} and service = ${row.service}`;
      await sql`update scrobble_accounts set last_error = ${outcome.reason}, last_error_at = ${now.toISOString()} where user_id = ${row.user_id} and service = ${row.service}`;
    }
  }
}

/** One request's worth: the same person, service and (Last.fm) application. */
interface SendGroup {
  service: ScrobbleService;
  userId: string;
  libraryId: string | null;
  secret: string;
  rows: Array<{ row: DueRow; track: ScrobbleTrack }>;
}

/**
 * Sends what is due. Returns how many were sent.
 *
 * A backlog (a person who just connected, a service back after an outage)
 * goes out batched: the claimed rows are grouped per person and service,
 * Last.fm takes up to 50 scrobbles per call and ListenBrainz a list of
 * listens, so one tick is at most one request per person and service. When
 * a call fails in a way that applies to the account (offline, rate limit, a
 * session that no longer works), the rest of that group is not tried this
 * tick: it waits with the same outcome.
 */
export async function sendDueScrobbles(deps: ScrobbleDeps, limit = 50): Promise<{ sent: number; other: number }> {
  const { sql } = deps;
  const env = deps.env ?? process.env;
  const now = new Date(deps.now?.() ?? Date.now());
  const rows = await claim(sql, limit, now);
  let sent = 0;
  let other = 0;
  const done = async (row: DueRow, outcome: SendOutcome) => {
    await settle(sql, row, outcome, now);
    if (outcome.kind === 'sent') sent++;
    else {
      other++;
      deps.log?.warn({ playId: row.play_id, service: row.service, outcome: outcome.kind, reason: outcome.reason }, 'scrobble not sent');
    }
  };

  const secrets = new Map<string, string | null>();
  const groups = new Map<string, SendGroup>();
  for (const row of rows) {
    const track = scrobbleTrackOf(row);
    const who = `${row.user_id}|${row.service}`;
    if (!secrets.has(who)) {
      const account = (await sql<{ secret_sealed: string }[]>`
        select secret_sealed from scrobble_accounts where user_id = ${row.user_id} and service = ${row.service}`)[0];
      let secret: string | null = null;
      if (account) { try { secret = openSecret(account.secret_sealed, appSecret()); } catch { secret = ''; } }
      secrets.set(who, secret);
    }
    const secret = secrets.get(who);
    if (!track) await done(row, { kind: 'failed', reason: 'The track has no artist or title' });
    else if (secret == null) await done(row, { kind: 'failed', reason: 'Disconnected before it was sent' });
    else if (now.getTime() - new Date(row.started_at).getTime() > MAX_SCROBBLE_AGE_MS) await done(row, { kind: 'ignored', reason: 'Older than 14 days' });
    else if (!secret) await done(row, { kind: 'auth', reason: 'The saved connection cannot be opened (APP_SECRET changed?); connect again' });
    else {
      // Last.fm signs with the library's application; ListenBrainz needs none
      const key = `${who}|${row.service === 'lastfm' ? row.library_id ?? '' : ''}`;
      const g = groups.get(key) ?? { service: row.service, userId: row.user_id, libraryId: row.library_id, secret, rows: [] };
      g.rows.push({ row, track });
      groups.set(key, g);
    }
  }

  const apps = new Map<string, LastfmApp | null>();
  const f = deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {};
  for (const g of groups.values()) {
    g.rows.sort((a, b) => new Date(a.row.started_at).getTime() - new Date(b.row.started_at).getTime());
    let stop: SendOutcome | null = null;
    for (let i = 0; i < g.rows.length; i += LASTFM_BATCH_MAX) {
      const chunk = g.rows.slice(i, i + LASTFM_BATCH_MAX);
      let outcomes: SendOutcome[];
      if (stop) {
        const same: SendOutcome = stop;
        outcomes = chunk.map(() => same);
      } else {
        const items: TimedTrack[] = chunk.map((c) => ({ track: c.track, startedAt: new Date(c.row.started_at) }));
        if (g.service === 'lastfm') {
          const appKey = g.libraryId ?? '';
          if (!apps.has(appKey)) apps.set(appKey, await installLastfmApp(sql, env, g.libraryId));
          const app = apps.get(appKey);
          outcomes = app
            ? await lastfmScrobbleBatch(app, g.secret, items, f)
            : chunk.map((): SendOutcome => ({ kind: 'retry', reason: 'The Last.fm API key is not set (Settings › Playback › Scrobbling)' }));
        } else {
          const apiUrl = listenbrainzUrl(env);
          const one = await listenbrainzScrobbleBatch(g.secret, items, { ...f, ...(apiUrl ? { apiUrl } : {}) });
          outcomes = chunk.map(() => one);
        }
        stop = outcomes.find((o) => o.kind === 'retry' || o.kind === 'auth') ?? null;
      }
      for (let k = 0; k < chunk.length; k++) await done(chunk[k]!.row, outcomes[k]!);
    }
  }
  return { sent, other };
}

// -- now playing --------------------------------------------------------------------------------

/** "Now playing" to each connected service, best effort: never queued, never retried. */
export async function sendNowPlaying(deps: ScrobbleDeps, userId: string, libraryId: string | null, track: ScrobbleTrack): Promise<number> {
  const { sql } = deps;
  const env = deps.env ?? process.env;
  const rows = await sql<{ service: ScrobbleService; secret_sealed: string }[]>`
    select service, secret_sealed from scrobble_accounts where user_id = ${userId}`;
  let n = 0;
  for (const r of rows) {
    let secret: string;
    try { secret = openSecret(r.secret_sealed, appSecret()); } catch { continue; }
    const f = deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {};
    let out: SendOutcome;
    if (r.service === 'lastfm') {
      const app = await installLastfmApp(sql, env, libraryId);
      if (!app) continue;
      out = await lastfmNowPlaying(app, secret, track, f);
    } else {
      const apiUrl = listenbrainzUrl(env);
      out = await listenbrainzNowPlaying(secret, track, { ...f, ...(apiUrl ? { apiUrl } : {}) });
    }
    if (out.kind === 'sent') n++;
    else if (out.kind === 'auth') {
      await sql`update scrobble_accounts set last_error = ${out.reason}, last_error_at = now() where user_id = ${userId} and service = ${r.service}`;
    }
  }
  return n;
}

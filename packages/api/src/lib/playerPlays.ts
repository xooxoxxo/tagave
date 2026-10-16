/**
 * Plays → tagave listens, per person.
 *
 * Two ways a play reaches tagave:
 *
 *  - tagave's web player: its completed / skipped events (player_events)
 *    become plays here. A play heard enough is also reported to the player
 *    server as that person (Subsonic `scrobble`), so the server's play
 *    counts match; the person's count snapshot is moved past it under the
 *    same per-person lock, so the poll below never mistakes it for a play
 *    from another app.
 *
 *  - another app (a phone app) playing through the player server: tagave
 *    polls each person's account on the server. Subsonic has no play
 *    history, so the poll reads the person's recently played albums
 *    (getAlbumList2 type=recent, which carries the OpenSubsonic `played`
 *    time) and those albums' songs with this person's play counts; a count
 *    that went up is that many new plays, the last one at `played`. The n-th
 *    counted play of a song is the key (server:<server>:<song>:<n>), so a
 *    poll that sees the same counts again, or is run twice, adds nothing.
 *    The first poll of a person only records counts: plays from before
 *    tagave looked are not turned into listens or scrobbles. Limits: a play
 *    an app reports days late (offline) for an album that is no longer near
 *    the top of the list is missed; two plays of one song between polls get
 *    estimated start times.
 *
 * A listen: one person heard at least half the album's tracks within six
 * hours of the first of them. Each play joins at most one listen, so a
 * second run never makes another; a later play of a track the listen does
 * not have yet, within those six hours, joins it.
 */
import type postgres from 'postgres';
import {
  getAlbum,
  getAlbumList2,
  getNowPlaying,
  getSong,
  scrobble,
  SubsonicError,
  type PlayerBackend,
  type ServerSong,
} from '@tagave/core/player';
import { heardEnough, scrobbleWorthy, type ScrobbleTrack } from '@tagave/core/scrobble';
import { personServer, playerUserRow, type PersonServer } from './playerPeople.js';
import { enqueueScrobbles, sendNowPlaying, servicesFor, type ScrobbleDeps } from './scrobbling.js';

type Sql = postgres.Sql;

export const LISTEN_WINDOW_MS = 6 * 3600_000;
/** now-playing events older than this are history, not "now" */
const NOW_PLAYING_FRESH_MS = 2 * 60_000;
/** a web play not reported to the server within a day is not reported */
const REPORT_GIVE_UP_MS = 24 * 3600_000;

export interface PlaysDeps extends ScrobbleDeps {
  backendFor: (libraryId: string | null) => Promise<PlayerBackend | null>;
}

/** postgres.js here takes timestamps as ISO strings */
const ts = (d: Date | string | number | null | undefined): string | null => (d == null ? null : new Date(d).toISOString());

const lock = (tx: postgres.TransactionSql, userId: string) => tx`select pg_advisory_xact_lock(hashtext(${`tagave:player-plays:${userId}`}))`;

// -- metadata ---------------------------------------------------------------------------

interface TrackMeta {
  local_track_id: string;
  local_album_id: string;
  library_id: string;
  release_id: string | null;
  title: string | null;
  artist: string | null;
  album: string | null;
  album_artist: string | null;
  track_no: number | null;
  duration_ms: number | null;
  recording_mbid: string | null;
  release_mbid: string | null;
}

async function trackMeta(sql: Sql, localTrackId: string): Promise<TrackMeta | null> {
  const rows = await sql<TrackMeta[]>`
    select lt.id as local_track_id, la.id as local_album_id, la.library_id, la.release_id,
           coalesce(ct.title, lt.title_guess) as title,
           coalesce(lt.artist_guess, la.artist_guess) as artist,
           coalesce(r.title, la.title_guess) as album,
           la.artist_guess as album_artist,
           coalesce(ct.position, lt.track_no) as track_no,
           coalesce(lt.duration_ms, ct.length_ms) as duration_ms,
           coalesce(ct.recording_mbid, rec.mbid) as recording_mbid,
           coalesce(r.mbid, la.embedded_mbid) as release_mbid
    from local_tracks lt
    join local_albums la on la.id = lt.local_album_id
    left join releases r on r.id = la.release_id
    left join canonical_tracks ct on ct.id = lt.canonical_track_id
    left join recordings rec on rec.id = lt.recording_id
    where lt.id = ${localTrackId}`;
  return rows[0] ?? null;
}

export function trackOfMeta(m: Pick<TrackMeta, 'title' | 'artist' | 'album' | 'album_artist' | 'track_no' | 'duration_ms' | 'recording_mbid' | 'release_mbid'>): ScrobbleTrack | null {
  if (!m.title || !m.artist) return null;
  return { artist: m.artist, track: m.title, album: m.album, albumArtist: m.album_artist, trackNumber: m.track_no, durationMs: m.duration_ms, recordingMbid: m.recording_mbid, releaseMbid: m.release_mbid };
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * The local track a server song is: the cached mapping, else the one file
 * whose path ends the same way (the last three parts: artist/album/file).
 */
export async function localTrackForSong(sql: Sql, serverKey: string, song: ServerSong): Promise<string | null> {
  const mapped = await sql<{ local_track_id: string }[]>`
    select local_track_id from player_track_map where server_key = ${serverKey} and song_id = ${song.id} limit 1`;
  if (mapped[0]) return mapped[0].local_track_id;
  if (!song.path) return null;
  const parts = song.path.normalize('NFC').replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const tail = parts.slice(-3).join('/');
  const rows = await sql<{ id: string }[]>`
    select lt.id from local_tracks lt join audio_files af on af.id = lt.audio_file_id
    where lt.origin <> 'cue' and (af.rel_path = ${tail} or af.rel_path like ${`%/${likeEscape(tail)}`})
    limit 2`;
  if (rows.length !== 1) return null;
  await sql`
    insert into player_track_map (local_track_id, server_key, song_id, server_album_id, server_path, matched_by)
    values (${rows[0]!.id}, ${serverKey}, ${song.id}, ${song.albumId}, ${song.path}, 'path')
    on conflict (local_track_id) do nothing`;
  return rows[0]!.id;
}

// -- inserting a play -----------------------------------------------------------------------

interface NewPlay {
  userId: string;
  libraryId: string | null;
  dedupeKey: string;
  source: 'web' | 'server';
  meta: Partial<TrackMeta> & { title: string };
  serverKey: string | null;
  serverSongId: string | null;
  playedMs: number | null;
  startedAt: Date;
  heard: boolean;
  scrobbles: boolean;
  serverReport: 'none' | 'pending';
}

/** Inserts the play once; returns its id when it is new, null when it was already there. */
async function insertPlay(sql: Sql | postgres.TransactionSql, p: NewPlay): Promise<string | null> {
  const m = p.meta;
  const rows = await sql<{ id: string }[]>`
    insert into player_plays (user_id, library_id, dedupe_key, source, local_track_id, local_album_id, release_id,
      server_key, server_song_id, title, artist, album, album_artist, track_no, recording_mbid, release_mbid,
      duration_ms, played_ms, started_at, heard, scrobbles, server_report)
    values (${p.userId}, ${p.libraryId}, ${p.dedupeKey}, ${p.source}, ${m.local_track_id ?? null}, ${m.local_album_id ?? null}, ${m.release_id ?? null},
      ${p.serverKey}, ${p.serverSongId}, ${m.title}, ${m.artist ?? null}, ${m.album ?? null}, ${m.album_artist ?? null}, ${m.track_no ?? null},
      ${m.recording_mbid ?? null}, ${m.release_mbid ?? null}, ${m.duration_ms ?? null}, ${p.playedMs}, ${ts(p.startedAt)}, ${p.heard}, ${p.scrobbles}, ${p.serverReport})
    on conflict (user_id, dedupe_key) do nothing
    returning id`;
  return rows[0]?.id ?? null;
}

async function queueScrobbles(sql: Sql, userId: string, playId: string, person: PersonServer | null): Promise<void> {
  // the owner's server scrobbles for this person already: it would be a second one
  if (person?.serverScrobbles) return;
  await enqueueScrobbles(sql, playId, await servicesFor(sql, userId));
}

// -- 1. the web player's events --------------------------------------------------------------

interface EventRow {
  id: string;
  user_id: string;
  library_id: string;
  local_track_id: string | null;
  kind: 'now_playing' | 'completed' | 'skipped';
  played_ms: number;
  position_ms: number;
  duration_ms: number | null;
  occurred_at: Date;
}

export interface EventsResult { plays: number; nowPlaying: number; events: number; users: Set<string> }

/**
 * Turns unprocessed play events into plays, in one transaction per batch
 * (an event is marked processed together with its play). Now-playing goes
 * out after the commit.
 */
export async function processPlayEvents(deps: PlaysDeps, limit = 200): Promise<EventsResult> {
  const { sql } = deps;
  const now = deps.now?.() ?? Date.now();
  const nowPlaying: Array<{ userId: string; libraryId: string; localTrackId: string }> = [];
  const fresh: Array<{ userId: string; playId: string; libraryId: string }> = [];
  const result: EventsResult = { plays: 0, nowPlaying: 0, events: 0, users: new Set() };
  await sql.begin(async (tx) => {
    const events = await tx<EventRow[]>`
      select id, user_id, library_id, local_track_id, kind, played_ms, position_ms, duration_ms, occurred_at
      from player_events where processed_at is null
      order by occurred_at limit ${limit}
      for update skip locked`;
    result.events = events.length;
    for (const e of events) {
      if (!e.local_track_id) continue;
      if (e.kind === 'now_playing') {
        if (now - new Date(e.occurred_at).getTime() < NOW_PLAYING_FRESH_MS) nowPlaying.push({ userId: e.user_id, libraryId: e.library_id, localTrackId: e.local_track_id });
        continue;
      }
      const meta = await trackMeta(tx as unknown as Sql, e.local_track_id);
      if (!meta) continue;
      const duration = meta.duration_ms ?? e.duration_ms;
      const heard = heardEnough(e.played_ms, duration);
      const playId = await insertPlay(tx, {
        userId: e.user_id,
        libraryId: e.library_id,
        dedupeKey: `event:${e.id}`,
        source: 'web',
        meta: { ...meta, title: meta.title ?? 'Untitled', duration_ms: duration },
        serverKey: null,
        serverSongId: null,
        playedMs: e.played_ms,
        startedAt: new Date(new Date(e.occurred_at).getTime() - e.played_ms),
        heard,
        scrobbles: scrobbleWorthy(e.played_ms, duration),
        serverReport: heard ? 'pending' : 'none',
      });
      if (playId) {
        result.plays++;
        result.users.add(e.user_id);
        if (scrobbleWorthy(e.played_ms, duration)) fresh.push({ userId: e.user_id, playId, libraryId: e.library_id });
      }
    }
    if (events.length) await tx`update player_events set processed_at = now() where id = any(${events.map((e) => e.id)}::uuid[])`;
  });
  for (const f of fresh) {
    const backend = await deps.backendFor(f.libraryId);
    const person = backend ? await personServer(sql, backend, f.userId).catch(() => null) : null;
    await queueScrobbles(sql, f.userId, f.playId, person);
  }
  for (const n of nowPlaying) {
    const meta = await trackMeta(sql, n.localTrackId);
    const track = meta && trackOfMeta(meta);
    const backend = await deps.backendFor(n.libraryId);
    const person = backend ? await personServer(sql, backend, n.userId).catch(() => null) : null;
    // the person's "now playing" on the server too (their own account only)
    if (backend && person?.personal) {
      const songId = (await sql<{ song_id: string }[]>`select song_id from player_track_map where local_track_id = ${n.localTrackId} and server_key = ${backend.key}`)[0]?.song_id;
      if (songId) await scrobble(person.server, songId, { submission: false, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) }).catch(() => undefined);
    }
    if (track && !person?.serverScrobbles) result.nowPlaying += await sendNowPlaying(deps, n.userId, n.libraryId, track).catch(() => 0);
  }
  return result;
}

// -- 2. web plays → the server's play counts ------------------------------------------------------

/**
 * Reports heard web plays to the player server as their person, so the
 * server's counts (and phone apps' "most played") include them. Under the
 * person's lock, the count snapshot moves past the reported play.
 */
export async function reportWebPlays(deps: PlaysDeps, limit = 100): Promise<number> {
  const { sql } = deps;
  const now = deps.now?.() ?? Date.now();
  const f = deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {};
  const pending = await sql<{ id: string; user_id: string; library_id: string | null; local_track_id: string | null; started_at: Date }[]>`
    select id, user_id, library_id, local_track_id, started_at from player_plays
    where server_report = 'pending' order by started_at limit ${limit}`;
  let done = 0;
  for (const p of pending) {
    const backend = await deps.backendFor(p.library_id);
    const person = backend ? await personServer(sql, backend, p.user_id, { create: true, ...f }).catch(() => null) : null;
    const songId = backend && p.local_track_id
      ? (await sql<{ song_id: string }[]>`select song_id from player_track_map where local_track_id = ${p.local_track_id} and server_key = ${backend.key}`)[0]?.song_id
      : undefined;
    if (!backend || !person?.personal || !songId) {
      // nobody to report it as (a shared account), or the server lost the song
      await sql`update player_plays set server_report = 'none' where id = ${p.id}`;
      continue;
    }
    if (now - new Date(p.started_at).getTime() > REPORT_GIVE_UP_MS) {
      await sql`update player_plays set server_report = 'failed' where id = ${p.id}`;
      continue;
    }
    try {
      await sql.begin(async (tx) => {
        await lock(tx, p.user_id);
        const still = await tx`select 1 from player_plays where id = ${p.id} and server_report = 'pending' for update`;
        if (!still.length) return;
        await scrobble(person.server, songId, { submission: true, time: new Date(p.started_at).getTime(), ...f });
        const song = await getSong(person.server, songId, f);
        await tx`
          insert into player_song_counts (user_id, server_key, song_id, play_count, played_at)
          values (${p.user_id}, ${backend.key}, ${songId}, ${song.playCount ?? 1}, ${ts(song.played)})
          on conflict (user_id, server_key, song_id) do update set play_count = excluded.play_count, played_at = excluded.played_at, updated_at = now()`;
        await tx`update player_plays set server_report = 'done', server_key = ${backend.key}, server_song_id = ${songId} where id = ${p.id}`;
      });
      done++;
    } catch (err) {
      if (err instanceof SubsonicError && err.code === 70) await sql`update player_plays set server_report = 'failed' where id = ${p.id}`;
      deps.log?.warn({ playId: p.id, err: (err as Error).message }, 'could not report a play to the player server');
    }
  }
  return done;
}

// -- 3. plays from other apps ------------------------------------------------------------------------

const BASELINE_ALBUMS = 50;
const POLL_ALBUMS = 20;
/** always looked at, whatever their `played` says (a late offline report lands on a recent album) */
const ALWAYS_ALBUMS = 5;

export interface PollResult { users: number; plays: number; newPlayUsers: Set<string> }

/** Polls every person who has their own account on this server. */
export async function pollServerPlays(deps: PlaysDeps, backend: PlayerBackend): Promise<PollResult> {
  const { sql } = deps;
  const people = await sql<{ user_id: string }[]>`
    select pu.user_id from player_users pu join users u on u.id = pu.user_id
    where pu.server_key = ${backend.key} and pu.state = 'active' and u.disabled_at is null and u.removed_at is null`;
  const out: PollResult = { users: 0, plays: 0, newPlayUsers: new Set() };
  for (const { user_id } of people) {
    try {
      const n = await pollPerson(deps, backend, user_id);
      out.users++;
      out.plays += n;
      if (n > 0) out.newPlayUsers.add(user_id);
    } catch (err) {
      const message = (err as Error).message;
      deps.log?.warn({ userId: user_id, err: message }, 'player poll');
      await sql`
        insert into player_poll_state (user_id, server_key, last_poll_at, last_error, last_error_at)
        values (${user_id}, ${backend.key}, now(), ${message}, now())
        on conflict (user_id, server_key) do update set last_poll_at = now(), last_error = excluded.last_error, last_error_at = now()`;
      if (err instanceof SubsonicError && err.code == null && err.httpStatus == null) break; // the server is down: next round
    }
  }
  return out;
}

const time = (s: string | null | undefined) => (s ? new Date(s).getTime() : null);

export async function pollPerson(deps: PlaysDeps, backend: PlayerBackend, userId: string): Promise<number> {
  const { sql } = deps;
  const f = deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {};
  const person = await personServer(sql, backend, userId);
  if (!person?.personal) return 0;
  const created: string[] = [];
  await sql.begin(async (tx) => {
    await lock(tx, userId);
    const state = (await tx<{ baseline_at: Date | null; cursor_at: Date | null }[]>`
      select baseline_at, cursor_at from player_poll_state where user_id = ${userId} and server_key = ${backend.key}`)[0];
    const baseline = !state?.baseline_at;
    const baselineAt = state?.baseline_at ? new Date(state.baseline_at).getTime() : null;
    const albums = await getAlbumList2(person.server, 'recent', { size: baseline ? BASELINE_ALBUMS : POLL_ALBUMS, ...f });
    const cursor = state?.cursor_at ? new Date(state.cursor_at).getTime() : null;
    let newCursor = cursor ?? 0;
    const look = baseline ? albums : albums.filter((a, i) => i < ALWAYS_ALBUMS || a.played == null || cursor == null || (time(a.played) ?? 0) > cursor);
    for (const a of look) newCursor = Math.max(newCursor, time(a.played) ?? 0);
    for (const album of look) {
      const { songs } = await getAlbum(person.server, album.id, f);
      const counts = new Map((await tx<{ song_id: string; play_count: number }[]>`
        select song_id, play_count from player_song_counts
        where user_id = ${userId} and server_key = ${backend.key} and song_id = any(${songs.map((s) => s.id)}::text[])`).map((r) => [r.song_id, r.play_count]));
      for (const s of songs) {
        const pc = s.playCount ?? 0;
        if (pc <= 0) continue;
        const prev = counts.get(s.id);
        if (prev === pc) continue;
        if (!baseline) {
          let fresh: number;
          let base: number;
          if (prev == null) {
            // a song tagave has not counted yet: one new play when it was played since tagave
            // could last have seen it. Not only since the latest play: an app that was offline
            // reports its plays with the time they happened, which can be before this person's
            // latest play but still after tagave first looked.
            const since = cursor == null ? null : Math.min(cursor, baselineAt ?? cursor);
            fresh = s.played && (since == null || (time(s.played) ?? 0) > since) ? 1 : 0;
            base = pc - fresh;
          } else {
            fresh = Math.max(0, pc - prev);
            base = prev;
          }
          if (fresh > 0) {
            const localId = await localTrackForSong(tx as unknown as Sql, backend.key, s);
            const meta = localId ? await trackMeta(tx as unknown as Sql, localId) : null;
            const durationMs = meta?.duration_ms ?? (s.duration ? s.duration * 1000 : null);
            const last = time(s.played) ?? Date.now();
            for (let k = 1; k <= fresh; k++) {
              const playId = await insertPlay(tx, {
                userId,
                libraryId: meta?.library_id ?? null,
                dedupeKey: `server:${backend.key}:${s.id}:${base + k}`,
                source: 'server',
                meta: meta
                  ? { ...meta, title: meta.title ?? s.title, duration_ms: durationMs }
                  : { title: s.title, artist: s.artist, album: s.album, track_no: s.track, duration_ms: durationMs, recording_mbid: s.musicBrainzId },
                serverKey: backend.key,
                serverSongId: s.id,
                playedMs: null,
                startedAt: new Date(last - (fresh - k) * (durationMs ?? 0)),
                // the app reported it as played: it counts, if the track is long enough
                heard: true,
                scrobbles: scrobbleWorthy(durationMs ?? Number.MAX_SAFE_INTEGER, durationMs),
                serverReport: 'none',
              });
              if (playId) created.push(playId);
            }
          }
        }
        await tx`
          insert into player_song_counts (user_id, server_key, song_id, play_count, played_at)
          values (${userId}, ${backend.key}, ${s.id}, ${pc}, ${ts(s.played)})
          on conflict (user_id, server_key, song_id) do update set play_count = excluded.play_count, played_at = excluded.played_at, updated_at = now()`;
      }
    }
    await tx`
      insert into player_poll_state (user_id, server_key, baseline_at, cursor_at, last_poll_at)
      values (${userId}, ${backend.key}, now(), ${newCursor ? ts(newCursor) : null}, now())
      on conflict (user_id, server_key) do update set baseline_at = coalesce(player_poll_state.baseline_at, excluded.baseline_at),
        cursor_at = greatest(player_poll_state.cursor_at, excluded.cursor_at), last_poll_at = now(), last_error = null, last_error_at = null`;
  });
  for (const playId of created) {
    const scrobbles = (await sql<{ scrobbles: boolean }[]>`select scrobbles from player_plays where id = ${playId}`)[0]?.scrobbles;
    if (scrobbles) await queueScrobbles(sql, userId, playId, person);
  }
  return created.length;
}

// -- 4. other apps' "now playing" -------------------------------------------------------------------

const forwarded = new Map<string, { songId: string; at: number }>();

export function clearNowPlayingMemory(): void {
  forwarded.clear();
}

/**
 * Forwards what other apps are playing right now, per person, to their
 * services' "now playing" (once per song; tagave's own entries are skipped,
 * the web player sends those itself).
 */
export async function forwardServerNowPlaying(deps: PlaysDeps, backend: PlayerBackend): Promise<number> {
  const { sql } = deps;
  const f = deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {};
  const entries = await getNowPlaying(backend.server, f);
  const now = deps.now?.() ?? Date.now();
  let n = 0;
  for (const e of entries) {
    if (e.playerName === 'tagave' || e.minutesAgo > 1 || !e.username) continue;
    const who = (await sql<{ user_id: string; server_scrobbles: boolean }[]>`
      select user_id, server_scrobbles from player_users where server_key = ${backend.key} and lower(username) = lower(${e.username}) and state = 'active'`)[0];
    if (!who || who.server_scrobbles) continue;
    const seen = forwarded.get(who.user_id);
    if (seen && seen.songId === e.song.id && now - seen.at < 10 * 60_000) continue;
    forwarded.set(who.user_id, { songId: e.song.id, at: now });
    const localId = await localTrackForSong(sql, backend.key, e.song);
    const meta = localId ? await trackMeta(sql, localId) : null;
    const track = meta
      ? trackOfMeta(meta)
      : trackOfMeta({ title: e.song.title, artist: e.song.artist, album: e.song.album, album_artist: null, track_no: e.song.track, duration_ms: e.song.duration ? e.song.duration * 1000 : null, recording_mbid: e.song.musicBrainzId, release_mbid: null });
    if (track) n += await sendNowPlaying(deps, who.user_id, meta?.library_id ?? null, track).catch(() => 0);
  }
  return n;
}

// -- 5. listens ------------------------------------------------------------------------------------

interface PlayRow { id: string; local_track_id: string; started_at: Date; player_listen_id: string | null }

/**
 * Makes album listens from this person's heard plays. Idempotent: plays
 * that joined a listen are never looked at again, and a listen's start is
 * unique per person and album.
 */
export async function deriveListens(sql: Sql, userId: string): Promise<number> {
  let made = 0;
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`tagave:player-listens:${userId}`}))`;
    const albums = await tx<{ local_album_id: string }[]>`
      select distinct local_album_id from player_plays
      where user_id = ${userId} and heard and player_listen_id is null and local_album_id is not null
        and started_at > now() - interval '30 days'`;
    for (const { local_album_id } of albums) {
      const album = (await tx<{ library_id: string; release_id: string | null; release_group_id: string | null; total: number }[]>`
        select la.library_id, la.release_id, coalesce(la.release_group_id, r.release_group_id) as release_group_id,
               (select count(*)::int from local_tracks t where t.local_album_id = la.id) as total
        from local_albums la left join releases r on r.id = la.release_id where la.id = ${local_album_id}`)[0];
      if (!album || album.total === 0) continue;
      const need = Math.max(1, Math.ceil(album.total / 2));
      const plays = await tx<PlayRow[]>`
        select id, local_track_id, started_at, player_listen_id from player_plays
        where user_id = ${userId} and local_album_id = ${local_album_id} and heard and local_track_id is not null
          and started_at > now() - interval '31 days'
        order by started_at, id`;
      const listens = await tx<{ id: string; started_at: Date }[]>`
        select id, started_at from player_listens where user_id = ${userId} and local_album_id = ${local_album_id}
          and started_at > now() - interval '32 days' order by started_at`;
      const tracksOf = new Map<string, Set<string>>();
      for (const p of plays) if (p.player_listen_id) {
        if (!tracksOf.has(p.player_listen_id)) tracksOf.set(p.player_listen_id, new Set());
        tracksOf.get(p.player_listen_id)!.add(p.local_track_id);
      }
      const attach = async (listenId: string, ps: PlayRow[]) => {
        await tx`update player_plays set player_listen_id = ${listenId} where id = any(${ps.map((p) => p.id)}::uuid[])`;
        for (const p of ps) { p.player_listen_id = listenId; tracksOf.get(listenId)?.add(p.local_track_id); }
        await tx`
          update player_listens pl set tracks_heard = (select count(distinct local_track_id)::int from player_plays where player_listen_id = pl.id),
            ended_at = greatest(pl.ended_at, (select max(started_at) from player_plays where player_listen_id = pl.id))
          where pl.id = ${listenId}`;
      };
      for (const p of plays) {
        if (p.player_listen_id) continue;
        const t = new Date(p.started_at).getTime();
        // joins a listen it falls into, when that listen does not have this track yet
        const into = listens.find((l) => {
          const s = new Date(l.started_at).getTime();
          return t >= s && t - s <= LISTEN_WINDOW_MS && !tracksOf.get(l.id)?.has(p.local_track_id);
        });
        if (into) { await attach(into.id, [p]); continue; }
        const window: PlayRow[] = [];
        const seen = new Set<string>();
        for (const q of plays) {
          if (q.player_listen_id) continue;
          const qt = new Date(q.started_at).getTime();
          if (qt < t || qt - t > LISTEN_WINDOW_MS || seen.has(q.local_track_id)) continue;
          seen.add(q.local_track_id);
          window.push(q);
        }
        if (seen.size < need) continue;
        const ended = new Date(Math.max(...window.map((q) => new Date(q.started_at).getTime())));
        const inserted = await tx<{ id: string }[]>`
          insert into player_listens (user_id, library_id, local_album_id, release_id, release_group_id, started_at, ended_at, tracks_heard, tracks_total)
          values (${userId}, ${album.library_id}, ${local_album_id}, ${album.release_id}, ${album.release_group_id}, ${ts(p.started_at)}, ${ts(ended)}, ${seen.size}, ${album.total})
          on conflict (user_id, local_album_id, started_at) do nothing
          returning id`;
        if (!inserted[0]) continue;
        const listenId = inserted[0].id;
        listens.push({ id: listenId, started_at: p.started_at });
        tracksOf.set(listenId, new Set());
        await attach(listenId, window);
        if (album.release_group_id) {
          const row = await tx<{ id: string }[]>`
            insert into listens (library_id, user_id, release_group_id, release_id, listened_at, format, source)
            values (${album.library_id}, ${userId}, ${album.release_group_id}, ${album.release_id}, ${ts(ended)}, 'digital', 'player')
            returning id`;
          await tx`update player_listens set listen_id = ${row[0]!.id} where id = ${listenId}`;
        }
        made++;
      }
    }
  });
  return made;
}

/** Helpers for routes and the person's history. */
export async function pollStateOf(sql: Sql, userId: string, serverKey: string): Promise<{ last_poll_at: Date | null; last_error: string | null } | null> {
  return (await sql<{ last_poll_at: Date | null; last_error: string | null }[]>`
    select last_poll_at, last_error from player_poll_state where user_id = ${userId} and server_key = ${serverKey}`)[0] ?? null;
}

export { playerUserRow };

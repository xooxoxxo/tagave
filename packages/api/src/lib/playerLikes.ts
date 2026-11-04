/**
 * Likes and the player server, per person (0085):
 *
 *   stars    tagave's likes are the person's stars on the player server, so
 *            Subsonic apps (Symfonium, Substreamer…) show them; stars made in
 *            those apps come back as likes. Both ways, every minute, one
 *            getStarred2 call per person. Navidrome is the other source of
 *            truth, so a change on either side wins over an older one.
 *   loves    a liked or unliked song goes to Last.fm (track.love / unlove)
 *            and ListenBrainz (feedback 1 / 0) on each connection with loves
 *            on, queued in player_loves and sent like scrobbles.
 *
 * How the two sides are compared: player_like_sync holds each server item
 * the two sides last agreed was starred, with when. Then, for each item:
 *
 *   liked here, starred there         agreed (remembered)
 *   liked here, not starred there     agreed before and not liked again since: unstarred in an app,
 *                                     so the like goes; otherwise a new like: star it
 *   starred there, not liked here     the newer of the server's star and tagave's unlike
 *                                     (like_removals, else the last agreement) wins: like it, or unstar it
 *   neither, but remembered           forgotten
 *
 * Only a person with their own account on the server is synced (a shared
 * account's stars are everyone's). Like the ratings (playerRatings.ts),
 * tracks the server has not been matched to yet are matched a few albums per run.
 */
import type postgres from 'postgres';
import {
  getAlbum, getStarred2, starItems, type PlayerBackend, type ServerAlbum, type ServerArtist, type ServerSong,
} from '@tagave/core/player';
import { lastfmLove, listenbrainzFeedback, MAX_SCROBBLE_AGE_MS, retryDelayMs, type SendOutcome } from '@tagave/core/scrobble';
import { openSecret } from '@tagave/core';
import type { LikeKind, ScrobbleService } from '@tagave/shared';
import { personServer, appSecret } from './playerPeople.js';
import { albumById, albumQueue } from './player.js';
import { localTrackForSong } from './playerPlays.js';
import { addLike, healLikes, removeLike, targetOf, type LikeTarget } from './likes.js';
import { installLastfmApp, listenbrainzUrl } from './scrobbling.js';

type Sql = postgres.Sql;

/** Albums matched to the server per person per run. */
const MAP_PER_RUN = 5;
/** Server artists looked up (getAlbum) per person per run. */
const ARTISTS_PER_RUN = 5;
const MAX_LOVE_ATTEMPTS = 12;
const STUCK_SENDING_MS = 10 * 60_000;

export interface LikeSyncDeps {
  sql: Sql;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  log?: { warn: (o: object, m: string) => void };
}

interface Side { at: number; target: string }
type Kind = LikeKind;
const KINDS: Kind[] = ['song', 'album', 'artist'];
const t0 = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() || 0 : 0);
const ms = (d: Date | string) => new Date(d).getTime();

/** tagave's side: each liked thing the server knows, by its server id. */
async function tagaveSide(deps: LikeSyncDeps, backend: PlayerBackend, userId: string, serverOf: (artistId: string) => Promise<string | null>): Promise<Record<Kind, Map<string, Side>>> {
  const { sql } = deps;
  const key = backend.key;
  const songs = await sql<Array<{ song_id: string; track_id: string; liked_at: Date }>>`
    select ptm.song_id, x.track_id::text as track_id, max(x.liked_at) as liked_at from (
      select l.local_track_id as track_id, l.liked_at from likes l where l.user_id = ${userId} and l.kind = 'song' and l.local_track_id is not null
      union all
      select lt.id, l.liked_at from likes l join canonical_tracks ct on ct.recording_mbid = l.recording_mbid join local_tracks lt on lt.canonical_track_id = ct.id
       where l.user_id = ${userId} and l.kind = 'song' and l.recording_mbid is not null
      union all
      select lt.id, l.liked_at from likes l join recordings rec on rec.mbid = l.recording_mbid join local_tracks lt on lt.recording_id = rec.id
       where l.user_id = ${userId} and l.kind = 'song' and l.recording_mbid is not null
    ) x join player_track_map ptm on ptm.local_track_id = x.track_id and ptm.server_key = ${key}
    group by ptm.song_id, x.track_id`;
  const albums = await sql<Array<{ server_album_id: string; album_id: string; liked_at: Date }>>`
    select ptm.server_album_id, x.album_id::text as album_id, max(x.liked_at) as liked_at from (
      select la.id as album_id, l.liked_at from likes l join local_albums la on la.release_group_id = l.release_group_id
       where l.user_id = ${userId} and l.kind = 'album' and l.release_group_id is not null
      union all
      select l.local_album_id, l.liked_at from likes l where l.user_id = ${userId} and l.kind = 'album' and l.local_album_id is not null
    ) x join local_tracks lt on lt.local_album_id = x.album_id
        join player_track_map ptm on ptm.local_track_id = lt.id and ptm.server_key = ${key} and ptm.server_album_id is not null
    group by ptm.server_album_id, x.album_id`;
  const artists = await sql<Array<{ artist_id: string; liked_at: Date }>>`
    select artist_id::text as artist_id, liked_at from likes where user_id = ${userId} and kind = 'artist'`;
  const out: Record<Kind, Map<string, Side>> = { song: new Map(), album: new Map(), artist: new Map() };
  for (const s of songs) out.song.set(s.song_id, { at: ms(s.liked_at), target: `song:${s.track_id}` });
  for (const a of albums) out.album.set(a.server_album_id, { at: ms(a.liked_at), target: `album:${a.album_id}` });
  for (const a of artists) {
    const id = await serverOf(a.artist_id);
    if (id) out.artist.set(id, { at: ms(a.liked_at), target: `artist:${a.artist_id}` });
  }
  return out;
}

/** When tagave last unliked each server item (like_removals of the last week), by kind and server id. */
async function removalsByServerId(sql: Sql, backend: PlayerBackend, userId: string, remembered: Map<string, string>): Promise<Map<string, number>> {
  const key = backend.key;
  const rows = await sql<Array<{ kind: Kind; server_id: string; removed_at: Date }>>`
    select 'song' as kind, ptm.song_id as server_id, max(x.removed_at) as removed_at from (
      select r.local_track_id as track_id, r.removed_at from like_removals r where r.user_id = ${userId} and r.kind = 'song' and r.local_track_id is not null
      union all
      select lt.id, r.removed_at from like_removals r join canonical_tracks ct on ct.recording_mbid = r.recording_mbid join local_tracks lt on lt.canonical_track_id = ct.id
       where r.user_id = ${userId} and r.kind = 'song' and r.recording_mbid is not null
    ) x join player_track_map ptm on ptm.local_track_id = x.track_id and ptm.server_key = ${key}
    group by ptm.song_id
    union all
    select 'album', ptm.server_album_id, max(x.removed_at) from (
      select r.local_album_id as album_id, r.removed_at from like_removals r where r.user_id = ${userId} and r.kind = 'album' and r.local_album_id is not null
      union all
      select la.id, r.removed_at from like_removals r join local_albums la on la.release_group_id = r.release_group_id
       where r.user_id = ${userId} and r.kind = 'album' and r.release_group_id is not null
    ) x join local_tracks lt on lt.local_album_id = x.album_id
        join player_track_map ptm on ptm.local_track_id = lt.id and ptm.server_key = ${key} and ptm.server_album_id is not null
    group by ptm.server_album_id
    union all
    select 'artist', r.artist_id::text, max(r.removed_at) from like_removals r
     where r.user_id = ${userId} and r.kind = 'artist' and r.artist_id is not null group by r.artist_id`;
  const out = new Map<string, number>();
  for (const r of rows) {
    // an artist's removal names the tagave artist: its server id is the one remembered for it
    const serverId = r.kind === 'artist' ? remembered.get(`artist:${r.server_id}`) : r.server_id;
    if (serverId) out.set(`${r.kind}|${serverId}`, Math.max(out.get(`${r.kind}|${serverId}`) ?? 0, ms(r.removed_at)));
  }
  return out;
}

/** The tagave thing a starred server item is, when tagave has it. */
async function importTarget(deps: LikeSyncDeps, backend: PlayerBackend, kind: Kind, item: ServerSong | ServerAlbum | ServerArtist): Promise<LikeTarget | null> {
  const { sql } = deps;
  if (kind === 'song') {
    const song = item as ServerSong;
    let trackId = await localTrackForSong(sql, backend.key, song);
    if (!trackId && song.musicBrainzId) {
      const [t] = await sql<Array<{ id: string }>>`
        select lt.id::text as id from canonical_tracks ct join local_tracks lt on lt.canonical_track_id = ct.id
         where ct.recording_mbid = ${song.musicBrainzId.toLowerCase()} order by lt.id limit 1`;
      trackId = t?.id ?? null;
    }
    return trackId ? targetOf(sql, 'song', trackId) : null;
  }
  if (kind === 'album') {
    const album = item as ServerAlbum;
    const [mapped] = await sql<Array<{ id: string }>>`
      select lt.local_album_id::text as id from player_track_map ptm join local_tracks lt on lt.id = ptm.local_track_id
       where ptm.server_key = ${backend.key} and ptm.server_album_id = ${album.id} and lt.local_album_id is not null limit 1`;
    let albumId = mapped?.id ?? null;
    if (!albumId && album.musicBrainzId) {
      const [byMbid] = await sql<Array<{ id: string }>>`
        select la.id::text as id from releases r join local_albums la on la.release_id = r.id where r.mbid = ${album.musicBrainzId.toLowerCase()} order by la.id limit 1`;
      albumId = byMbid?.id ?? null;
    }
    return albumId ? targetOf(sql, 'album', albumId) : null;
  }
  const artist = item as ServerArtist;
  const rows = artist.musicBrainzId
    ? await sql<Array<{ id: string }>>`select id::text as id from artists where mbid = ${artist.musicBrainzId.toLowerCase()} limit 1`
    : [];
  const found = rows[0] ?? (await sql<Array<{ id: string }>>`select id::text as id from artists where lower(name) = lower(${artist.name}) limit 2`).filter((_, i, all) => all.length === 1)[0];
  return found ? targetOf(sql, 'artist', found.id) : null;
}

/** The tagave target a remembered or tagave-side entry names. */
async function targetFromKey(sql: Sql, target: string): Promise<LikeTarget | null> {
  const [kind, id] = target.split(':') as [Kind, string];
  return KINDS.includes(kind) && id ? targetOf(sql, kind, id) : null;
}

/** Liked albums and liked songs' albums the server has no songs mapped for yet: matched now, a few per run. */
async function mapLiked(deps: LikeSyncDeps, backend: PlayerBackend, userId: string): Promise<void> {
  const { sql } = deps;
  const albums = await sql<Array<{ id: string }>>`
    select distinct a.id::text as id from (
      select la.id from likes l join local_albums la on la.release_group_id = l.release_group_id
       where l.user_id = ${userId} and l.kind = 'album' and l.release_group_id is not null
      union select l.local_album_id from likes l where l.user_id = ${userId} and l.kind = 'album' and l.local_album_id is not null
      union select lt.local_album_id from likes l join local_tracks lt on lt.id = l.local_track_id where l.user_id = ${userId} and l.kind = 'song'
    ) a(id)
     where a.id is not null and not exists (
       select 1 from local_tracks lt join player_track_map ptm on ptm.local_track_id = lt.id and ptm.server_key = ${backend.key} where lt.local_album_id = a.id)
     limit ${MAP_PER_RUN}`;
  for (const a of albums) {
    const album = await albumById(sql, a.id);
    if (album) await albumQueue({ sql, boss: null, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) }, backend, album).catch(() => undefined);
  }
}

export interface LikeSyncResult { starred: number; unstarred: number; liked: number; unliked: number }

/** One person: both sides compared and brought together. */
export async function syncPersonLikes(deps: LikeSyncDeps, backend: PlayerBackend, userId: string): Promise<LikeSyncResult> {
  const { sql } = deps;
  const result: LikeSyncResult = { starred: 0, unstarred: 0, liked: 0, unliked: 0 };
  const person = await personServer(sql, backend, userId);
  if (!person?.personal) return result;
  const f = deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {};
  const now = deps.now?.() ?? Date.now();
  await healLikes(sql, userId);
  await mapLiked(deps, backend, userId);

  const remembered = await sql<Array<{ kind: Kind; server_id: string; target: string; synced_at: Date }>>`
    select kind, server_id, target, synced_at from player_like_sync where user_id = ${userId} and server_key = ${backend.key}`;
  const memo = new Map(remembered.map((m) => [`${m.kind}|${m.server_id}`, m]));
  const artistServerId = new Map(remembered.filter((m) => m.kind === 'artist').map((m) => [m.target, m.server_id]));

  let artistLookups = 0;
  const serverOfArtist = async (artistId: string): Promise<string | null> => {
    const known = artistServerId.get(`artist:${artistId}`);
    if (known) return known;
    if (artistLookups >= ARTISTS_PER_RUN) return null;
    const [row] = await sql<Array<{ server_album_id: string }>>`
      select ptm.server_album_id from release_group_artists rga
        join local_albums la on la.release_group_id = rga.release_group_id
        join local_tracks lt on lt.local_album_id = la.id
        join player_track_map ptm on ptm.local_track_id = lt.id and ptm.server_key = ${backend.key} and ptm.server_album_id is not null
       where rga.artist_id = ${artistId} order by rga.position limit 1`;
    if (!row) return null;
    artistLookups++;
    const got = await getAlbum(person.server, row.server_album_id, f).catch(() => null);
    const id = got?.album.artistId ?? null;
    if (id) artistServerId.set(`artist:${artistId}`, id);
    return id;
  };

  const starred = await getStarred2(person.server, f);
  const serverSide: Record<Kind, Map<string, { at: number; item: ServerSong | ServerAlbum | ServerArtist }>> = {
    song: new Map(starred.songs.map((s) => [s.id, { at: t0(s.starred), item: s }])),
    album: new Map(starred.albums.map((a) => [a.id, { at: t0(a.starred), item: a }])),
    artist: new Map(starred.artists.map((a) => [a.id, { at: t0(a.starred), item: a }])),
  };
  const here = await tagaveSide(deps, backend, userId, serverOfArtist);
  const removed = await removalsByServerId(sql, backend, userId, artistServerId);

  const remember = async (kind: Kind, serverId: string, target: string) => {
    await sql`
      insert into player_like_sync (user_id, server_key, kind, server_id, target, synced_at)
      values (${userId}, ${backend.key}, ${kind}, ${serverId}, ${target}, ${new Date(now).toISOString()})
      on conflict (user_id, server_key, kind, server_id) do update set target = excluded.target, synced_at = excluded.synced_at`;
  };
  const forget = (kind: Kind, serverId: string) =>
    sql`delete from player_like_sync where user_id = ${userId} and server_key = ${backend.key} and kind = ${kind} and server_id = ${serverId}`;

  for (const kind of KINDS) {
    const toStar: Array<{ id: string; target: string }> = [];
    const toUnstar: string[] = [];
    const ids = new Set([...here[kind].keys(), ...serverSide[kind].keys(), ...remembered.filter((m) => m.kind === kind).map((m) => m.server_id)]);
    for (const id of ids) {
      const mine = here[kind].get(id);
      const theirs = serverSide[kind].get(id);
      const memory = memo.get(`${kind}|${id}`);
      try {
        if (mine && theirs) {
          if (!memory || memory.target !== mine.target) await remember(kind, id, mine.target);
        } else if (mine) {
          if (memory && mine.at <= ms(memory.synced_at)) {
            // agreed before and not liked again since: unstarred in an app
            const t = await targetFromKey(sql, mine.target);
            if (t) result.unliked += await removeLike(sql, userId, t) > 0 ? 1 : 0;
            await forget(kind, id);
          } else {
            toStar.push({ id, target: mine.target });
          }
        } else if (theirs) {
          const unlikedAt = removed.get(`${kind}|${id}`) ?? (memory ? ms(memory.synced_at) : null);
          if (unlikedAt !== null && unlikedAt >= theirs.at) {
            toUnstar.push(id);
            if (memory) await forget(kind, id);
          } else {
            const t = await importTarget(deps, backend, kind, theirs.item);
            if (!t) continue;
            if (await addLike(sql, userId, t, { likedAt: new Date(theirs.at || now) })) result.liked++;
            await remember(kind, id, kind === 'song' ? `song:${t.localTrackId}` : kind === 'album' ? `album:${t.localAlbumId}` : `artist:${t.artistId}`);
          }
        } else if (memory) {
          await forget(kind, id);
        }
      } catch (err) {
        deps.log?.warn({ userId, kind, serverId: id, err: (err as Error).message }, 'like sync');
      }
    }
    if (toStar.length) {
      await starItems(person.server, kind, toStar.map((s) => s.id), true, f);
      for (const s of toStar) await remember(kind, s.id, s.target);
      result.starred += toStar.length;
    }
    if (toUnstar.length) {
      await starItems(person.server, kind, toUnstar, false, f);
      result.unstarred += toUnstar.length;
    }
  }
  return result;
}

/** Every person with their own account on this server. */
export async function syncLikes(deps: LikeSyncDeps, backend: PlayerBackend): Promise<number> {
  const people = await deps.sql<{ user_id: string }[]>`
    select pu.user_id from player_users pu join users u on u.id = pu.user_id
    where pu.server_key = ${backend.key} and pu.state = 'active' and u.disabled_at is null and u.removed_at is null`;
  let n = 0;
  for (const p of people) {
    try {
      const r = await syncPersonLikes(deps, backend, p.user_id);
      n += r.starred + r.unstarred + r.liked + r.unliked;
    } catch (err) {
      deps.log?.warn({ userId: p.user_id, err: (err as Error).message }, 'like sync');
    }
  }
  return n;
}

// -- loves ---------------------------------------------------------------------------------

interface LoveRow {
  id: string;
  user_id: string;
  service: ScrobbleService;
  love: boolean;
  title: string;
  artist: string;
  recording_mbid: string | null;
  attempts: number;
  created_at: Date;
}

/** Sends the loves that are due, one request each (a love is one song). Returns how many were sent. */
export async function sendDueLoves(deps: LikeSyncDeps, limit = 50): Promise<number> {
  const { sql } = deps;
  const env = deps.env ?? process.env;
  const now = new Date(deps.now?.() ?? Date.now());
  const stuck = new Date(now.getTime() - STUCK_SENDING_MS).toISOString();
  const rows = await sql<LoveRow[]>`
    with due as (
      select id from player_loves
       where (status = 'pending' and next_attempt_at <= greatest(${now.toISOString()}::timestamptz, now()))
          or (status = 'sending' and claimed_at < ${stuck})
       order by created_at limit ${limit} for update skip locked)
    update player_loves p set status = 'sending', claimed_at = ${now.toISOString()}, attempts = p.attempts + 1
      from due where p.id = due.id
    returning p.id, p.user_id, p.service, p.love, p.title, p.artist, p.recording_mbid, p.attempts, p.created_at`;
  let sent = 0;
  const f = deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {};
  for (const r of rows.sort((a, b) => ms(a.created_at) - ms(b.created_at))) {
    const [account] = await sql<{ secret_sealed: string; send_loves: boolean }[]>`
      select secret_sealed, send_loves from scrobble_accounts where user_id = ${r.user_id} and service = ${r.service}`;
    let out: SendOutcome;
    if (!account) out = { kind: 'failed', reason: 'Disconnected before it was sent' };
    else if (!account.send_loves) out = { kind: 'failed', reason: 'Loves turned off before it was sent' };
    else {
      let secret: string | null = null;
      try { secret = openSecret(account.secret_sealed, appSecret()); } catch { secret = null; }
      if (!secret) out = { kind: 'auth', reason: 'The saved connection cannot be opened (APP_SECRET changed?); connect again' };
      else if (r.service === 'lastfm') {
        const app = await installLastfmApp(sql, env, null);
        out = app ? await lastfmLove(app, secret, { artist: r.artist, track: r.title }, r.love, f)
          : { kind: 'retry', reason: 'The Last.fm API key is not set (Settings › Modules › Player › Scrobbling)' };
      } else {
        const apiUrl = listenbrainzUrl(env);
        out = await listenbrainzFeedback(secret, r.recording_mbid, r.love, { ...f, ...(apiUrl ? { apiUrl } : {}) });
      }
    }
    if (out.kind === 'sent') {
      sent++;
      await sql`update player_loves set status = 'sent', sent_at = ${now.toISOString()}, last_error = null where id = ${r.id}`;
    } else if (out.kind === 'ignored' || out.kind === 'failed') {
      await sql`update player_loves set status = ${out.kind}, last_error = ${out.reason} where id = ${r.id}`;
    } else {
      const giveUp = r.attempts >= MAX_LOVE_ATTEMPTS || now.getTime() - ms(r.created_at) > MAX_SCROBBLE_AGE_MS;
      const wait = out.kind === 'auth' ? 24 * 3600_000 : retryDelayMs(r.attempts);
      await sql`
        update player_loves set status = ${giveUp ? 'failed' : 'pending'}, last_error = ${out.reason},
          next_attempt_at = ${new Date(now.getTime() + wait).toISOString()} where id = ${r.id}`;
    }
    if (out.kind !== 'sent') deps.log?.warn({ loveId: r.id, service: r.service, outcome: out.kind, reason: out.reason }, 'love not sent');
  }
  return sent;
}

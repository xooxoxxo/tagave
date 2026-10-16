/**
 * Ratings flow one way: tagave → the player server, per person. tagave keeps
 * half stars; Subsonic takes whole stars 1–5, so a rating is rounded (half a
 * star becomes one) and a cleared rating clears the server's. Favourite
 * tracks of a review become starred songs. What was sent is remembered per
 * person and album, so only changes go out, and a person's first sync (a new
 * account, or a person who just connected their own) sends all their
 * ratings: the backfill.
 *
 * Polled (every minute) rather than hooked into the review routes, so it
 * also catches ratings made before the player existed and needs nothing
 * from the code that saves reviews.
 */
import type postgres from 'postgres';
import { setRating, star, unstar, type PlayerBackend } from '@tagave/core/player';
import { personServer } from './playerPeople.js';
import { albumById, albumQueue } from './player.js';

type Sql = postgres.Sql;

/** Albums matched per person per run when their tracks are not mapped to the server yet. */
const MAP_PER_RUN = 5;
const PER_PERSON_PER_RUN = 50;
/** an album the server does not have is tried again after this */
const UNMAPPED_RETRY_MS = 6 * 3600_000;

export function serverRating(rating: number | null): number {
  if (rating == null || !Number.isFinite(rating) || rating <= 0) return 0;
  return Math.min(5, Math.max(1, Math.round(rating)));
}

interface ReviewRow {
  library_id: string;
  release_group_id: string;
  rating: string | null;
  favorite_track_ids: string[] | null;
  updated_at: Date;
}

interface SyncRow {
  library_id: string;
  release_group_id: string;
  rating_sent: number | null;
  favorites_sent: string[];
  review_updated_at: Date | null;
  synced_at: Date;
}

async function serverAlbumIds(sql: Sql, serverKey: string, libraryId: string, rgId: string): Promise<string[]> {
  const rows = await sql<{ server_album_id: string }[]>`
    select distinct ptm.server_album_id from local_albums la
    left join releases r on r.id = la.release_id
    join local_tracks lt on lt.local_album_id = la.id
    join player_track_map ptm on ptm.local_track_id = lt.id and ptm.server_key = ${serverKey}
    where la.library_id = ${libraryId} and coalesce(la.release_group_id, r.release_group_id) = ${rgId} and ptm.server_album_id is not null`;
  return rows.map((r) => r.server_album_id);
}

async function favoriteSongIds(sql: Sql, serverKey: string, libraryId: string, rgId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await sql<{ song_id: string }[]>`
    select distinct ptm.song_id from local_albums la
    left join releases r on r.id = la.release_id
    join local_tracks lt on lt.local_album_id = la.id
    join player_track_map ptm on ptm.local_track_id = lt.id and ptm.server_key = ${serverKey}
    where la.library_id = ${libraryId} and coalesce(la.release_group_id, r.release_group_id) = ${rgId}
      and (lt.id = any(${ids}::uuid[]) or lt.canonical_track_id = any(${ids}::uuid[]))`;
  return rows.map((r) => r.song_id).sort();
}

export interface RatingSyncDeps {
  sql: Sql;
  fetchImpl?: typeof fetch;
  log?: { warn: (o: object, m: string) => void };
}

/** One person: sends what changed since the last run. Returns how many albums were sent. */
export async function syncPersonRatings(deps: RatingSyncDeps, backend: PlayerBackend, userId: string): Promise<number> {
  const { sql } = deps;
  const f = deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {};
  const person = await personServer(sql, backend, userId);
  if (!person?.personal) return 0;
  const reviews = await sql<ReviewRow[]>`
    select library_id, release_group_id, rating::text as rating, favorite_track_ids, updated_at
    from user_reviews where user_id = ${userId}`;
  const synced = await sql<SyncRow[]>`
    select library_id, release_group_id, rating_sent, favorites_sent, review_updated_at, synced_at
    from player_rating_sync where user_id = ${userId} and server_key = ${backend.key}`;
  const key = (l: string, rg: string) => `${l}|${rg}`;
  const syncedBy = new Map(synced.map((s) => [key(s.library_id, s.release_group_id), s]));
  const now = Date.now();
  type Todo = { libraryId: string; rgId: string; rating: number | null; favorites: string[]; updatedAt: Date | null; prev: SyncRow | undefined };
  const todo: Todo[] = [];
  for (const r of reviews) {
    const prev = syncedBy.get(key(r.library_id, r.release_group_id));
    const changed = !prev || !prev.review_updated_at || new Date(r.updated_at).getTime() > new Date(prev.review_updated_at).getTime();
    if (!changed) continue;
    // sent before but the server did not have the album: wait before asking again
    if (prev && !prev.review_updated_at && new Date(r.updated_at).getTime() <= new Date(prev.synced_at).getTime()
      && now - new Date(prev.synced_at).getTime() < UNMAPPED_RETRY_MS) continue;
    todo.push({ libraryId: r.library_id, rgId: r.release_group_id, rating: r.rating == null ? null : Number(r.rating), favorites: r.favorite_track_ids ?? [], updatedAt: r.updated_at, prev });
  }
  // a review deleted in tagave clears the server's rating and stars
  const reviewed = new Set(reviews.map((r) => key(r.library_id, r.release_group_id)));
  for (const s of synced) {
    if (!reviewed.has(key(s.library_id, s.release_group_id))) todo.push({ libraryId: s.library_id, rgId: s.release_group_id, rating: null, favorites: [], updatedAt: null, prev: s });
  }
  let mapped = 0;
  let sent = 0;
  for (const t of todo.slice(0, PER_PERSON_PER_RUN)) {
    let albums = await serverAlbumIds(sql, backend.key, t.libraryId, t.rgId);
    if (albums.length === 0 && mapped < MAP_PER_RUN) {
      mapped++;
      const local = (await sql<{ id: string }[]>`
        select la.id from local_albums la left join releases r on r.id = la.release_id
        where la.library_id = ${t.libraryId} and coalesce(la.release_group_id, r.release_group_id) = ${t.rgId} limit 2`);
      for (const l of local) {
        const album = await albumById(sql, l.id);
        if (album) await albumQueue({ sql, boss: null, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) }, backend, album).catch(() => undefined);
      }
      albums = await serverAlbumIds(sql, backend.key, t.libraryId, t.rgId);
    }
    if (albums.length === 0) {
      if (t.updatedAt) {
        await sql`
          insert into player_rating_sync (user_id, server_key, library_id, release_group_id, rating_sent, review_updated_at)
          values (${userId}, ${backend.key}, ${t.libraryId}, ${t.rgId}, null, null)
          on conflict (user_id, server_key, library_id, release_group_id) do update set synced_at = now()`;
      } else {
        await sql`delete from player_rating_sync where user_id = ${userId} and server_key = ${backend.key} and library_id = ${t.libraryId} and release_group_id = ${t.rgId}`;
      }
      continue;
    }
    try {
      const rating = serverRating(t.rating);
      if (rating !== (t.prev?.rating_sent ?? 0) || !t.prev?.review_updated_at) {
        for (const id of albums) await setRating(person.server, id, rating, f);
      }
      const songs = await favoriteSongIds(sql, backend.key, t.libraryId, t.rgId, t.favorites);
      const before = new Set(t.prev?.favorites_sent ?? []);
      const add = songs.filter((s) => !before.has(s));
      const drop = [...before].filter((s) => !songs.includes(s));
      await star(person.server, add, f);
      await unstar(person.server, drop, f);
      if (t.updatedAt) {
        await sql`
          insert into player_rating_sync (user_id, server_key, library_id, release_group_id, rating_sent, favorites_sent, review_updated_at)
          values (${userId}, ${backend.key}, ${t.libraryId}, ${t.rgId}, ${rating}, ${songs}, ${t.updatedAt ? new Date(t.updatedAt).toISOString() : null})
          on conflict (user_id, server_key, library_id, release_group_id) do update set rating_sent = excluded.rating_sent,
            favorites_sent = excluded.favorites_sent, review_updated_at = excluded.review_updated_at, synced_at = now()`;
      } else {
        await sql`delete from player_rating_sync where user_id = ${userId} and server_key = ${backend.key} and library_id = ${t.libraryId} and release_group_id = ${t.rgId}`;
      }
      sent++;
    } catch (err) {
      deps.log?.warn({ userId, releaseGroupId: t.rgId, err: (err as Error).message }, 'rating sync');
    }
  }
  return sent;
}

/** Every person with their own account on this server. */
export async function syncRatings(deps: RatingSyncDeps, backend: PlayerBackend): Promise<number> {
  const people = await deps.sql<{ user_id: string }[]>`
    select pu.user_id from player_users pu join users u on u.id = pu.user_id
    where pu.server_key = ${backend.key} and pu.state = 'active' and u.disabled_at is null and u.removed_at is null`;
  let n = 0;
  for (const p of people) {
    try { n += await syncPersonRatings(deps, backend, p.user_id); } catch (err) { deps.log?.warn({ userId: p.user_id, err: (err as Error).message }, 'rating sync'); }
  }
  return n;
}

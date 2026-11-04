/**
 * Likes (0085): each person's hearts on songs, albums and artists, and the
 * reads the app makes of them. Every query is the person's own.
 *
 * What a like is keyed on, and why it lasts (the migration says more):
 *   song    the local track and its recording MBID: a song is liked when
 *           either matches, so a rescan, Move, Split or re-import keeps it
 *   album   the release group (else the local album, until it is identified)
 *   artist  the artist
 *
 * A like of a song, and an unlike, also queues a love for each scrobbling
 * connection that sends them (player_loves, sent by the player's loop in
 * playerLikes.ts). An unlike leaves a like_removals row for a week: the
 * two-way sync with the player server compares it with when a Subsonic app
 * starred the same thing.
 */
import type postgres from 'postgres';
import { trackLiveSql } from '@tagave/db';
import type { LikeKeysView, LikeKind, LikedSongView, LikedSongsView } from '@tagave/shared';

type Sql = postgres.Sql<any>;
type Tx = postgres.TransactionSql<any>;

const isId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/** A track's recording MBID: the release track it is linked to, else the recording a fingerprint named. */
const RECORDING = `coalesce(ct.recording_mbid, rec.mbid)`;

export interface LikeTarget {
  kind: LikeKind;
  localTrackId?: string | null;
  recordingMbid?: string | null;
  releaseGroupId?: string | null;
  localAlbumId?: string | null;
  artistId?: string | null;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
}

/** What the thing named by the app's id is now, for a like to point at; null when there is no such thing. */
export async function targetOf(sql: Sql | Tx, kind: LikeKind, id: string): Promise<LikeTarget | null> {
  if (!isId(id)) return null;
  if (kind === 'song') {
    const [t] = await sql<Array<{ id: string; recording_mbid: string | null; title: string; artist: string | null; album: string | null }>>`
      select lt.id::text as id, ${sql.unsafe(RECORDING)} as recording_mbid,
             coalesce(nullif(lt.title_guess, ''), ct.title, 'Untitled') as title,
             coalesce(lt.artist_guess, la.artist_guess) as artist,
             coalesce(r.title, la.title_guess) as album
        from local_tracks lt
        left join local_albums la on la.id = lt.local_album_id
        left join releases r on r.id = la.release_id
        left join canonical_tracks ct on ct.id = lt.canonical_track_id
        left join recordings rec on rec.id = lt.recording_id
       where lt.id = ${id}`;
    return t ? { kind, localTrackId: t.id, recordingMbid: t.recording_mbid?.toLowerCase() ?? null, title: t.title, artist: t.artist, album: t.album } : null;
  }
  if (kind === 'album') {
    const [a] = await sql<Array<{ id: string; rg: string | null }>>`
      select la.id::text as id, coalesce(la.release_group_id, r.release_group_id)::text as rg
        from local_albums la left join releases r on r.id = la.release_id where la.id = ${id}`;
    return a ? { kind, localAlbumId: a.id, releaseGroupId: a.rg } : null;
  }
  const [ar] = await sql<Array<{ id: string; name: string }>>`select id::text as id, name from artists where id = ${id}`;
  return ar ? { kind, artistId: ar.id, artist: ar.name } : null;
}

/** The likes a target matches (a song by its track or its recording; an album by its release group or itself). */
function matchSql(sql: Sql | Tx, userId: string, t: LikeTarget) {
  if (t.kind === 'song') {
    return sql`user_id = ${userId} and kind = 'song' and (local_track_id = ${t.localTrackId ?? null}
      or (${t.recordingMbid ?? null}::text is not null and recording_mbid = ${t.recordingMbid ?? null}))`;
  }
  if (t.kind === 'album') {
    return sql`user_id = ${userId} and kind = 'album' and (release_group_id = ${t.releaseGroupId ?? null} or local_album_id = ${t.localAlbumId ?? null})`;
  }
  return sql`user_id = ${userId} and kind = 'artist' and artist_id = ${t.artistId ?? null}`;
}

/** Love or unlove a song, for each connection that sends loves. */
export async function queueLoves(sql: Sql | Tx, userId: string, song: { title: string | null; artist: string | null; recordingMbid: string | null }, love: boolean): Promise<number> {
  if (!song.title || !song.artist) return 0;
  const rows = await sql`
    insert into player_loves (user_id, service, love, title, artist, recording_mbid)
    select ${userId}, service, ${love}, ${song.title}, ${song.artist}, ${song.recordingMbid}
      from scrobble_accounts where user_id = ${userId} and send_loves
    returning 1`;
  return rows.length;
}

/**
 * Likes a target. Returns true when it is a new like (false: already liked).
 * likedAt: when (an import from the player server keeps the server's time).
 */
export async function addLike(sql: Sql | Tx, userId: string, t: LikeTarget, opts: { likedAt?: Date; loves?: boolean } = {}): Promise<boolean> {
  const at = (opts.likedAt ?? new Date()).toISOString();
  const rows = await sql`
    insert into likes (user_id, kind, local_track_id, recording_mbid, release_group_id, local_album_id, artist_id, title, artist, album, liked_at)
    select ${userId}, ${t.kind}, ${t.localTrackId ?? null}, ${t.recordingMbid ?? null}, ${t.releaseGroupId ?? null},
           ${t.kind === 'album' ? t.localAlbumId ?? null : null}, ${t.artistId ?? null}, ${t.title ?? null}, ${t.artist ?? null}, ${t.album ?? null}, ${at}
     where not exists (select 1 from likes where ${matchSql(sql, userId, t)})
    on conflict do nothing
    returning id`;
  if (rows.length === 0) return false;
  if (t.kind === 'song' && opts.loves !== false) await queueLoves(sql, userId, { title: t.title ?? null, artist: t.artist ?? null, recordingMbid: t.recordingMbid ?? null }, true);
  return true;
}

/** Unlikes a target: every like it matches goes, each leaving a removal. Returns how many went. */
export async function removeLike(sql: Sql | Tx, userId: string, t: LikeTarget, opts: { loves?: boolean } = {}): Promise<number> {
  const gone = await sql<Array<{ kind: LikeKind; local_track_id: string | null; recording_mbid: string | null; release_group_id: string | null; local_album_id: string | null; artist_id: string | null; title: string | null; artist: string | null }>>`
    delete from likes where ${matchSql(sql, userId, t)}
    returning kind, local_track_id, recording_mbid, release_group_id, local_album_id, artist_id, title, artist`;
  for (const g of gone) {
    await sql`
      insert into like_removals (user_id, kind, local_track_id, recording_mbid, release_group_id, local_album_id, artist_id)
      values (${userId}, ${g.kind}, ${g.local_track_id ?? t.localTrackId ?? null}, ${g.recording_mbid}, ${g.release_group_id}, ${g.local_album_id ?? (t.kind === 'album' ? t.localAlbumId ?? null : null)}, ${g.artist_id})`;
    if (g.kind === 'song' && opts.loves !== false) await queueLoves(sql, userId, { title: g.title ?? t.title ?? null, artist: g.artist ?? t.artist ?? null, recordingMbid: g.recording_mbid }, false);
  }
  return gone.length;
}

/** Unlikes one song like by its own id (Liked songs' Missing rows: no track to name it by). */
export async function removeLikeById(sql: Sql | Tx, userId: string, likeId: string): Promise<number> {
  if (!isId(likeId)) return 0;
  const [l] = await sql<Array<{ local_track_id: string | null; recording_mbid: string | null; title: string | null; artist: string | null }>>`
    select local_track_id, recording_mbid, title, artist from likes where id = ${likeId} and user_id = ${userId} and kind = 'song'`;
  if (!l) return 0;
  if (l.local_track_id || l.recording_mbid) {
    return removeLike(sql, userId, { kind: 'song', localTrackId: l.local_track_id, recordingMbid: l.recording_mbid, title: l.title, artist: l.artist });
  }
  return (await sql`delete from likes where id = ${likeId} and user_id = ${userId}`).count;
}

/**
 * Keeps likes pointing at what they mean: a song like whose track went
 * points at a live song of the same recording; an album like made before
 * the album was identified takes its release group; a like that names
 * nothing any more (an unidentified album that left) goes. Removals older
 * than a week go.
 */
export async function healLikes(sql: Sql | Tx, userId: string): Promise<void> {
  await sql`
    update likes l set local_track_id = t.id
      from (
        select l2.id as like_id, coalesce(
          (select lt.id from canonical_tracks ct join local_tracks lt on lt.canonical_track_id = ct.id
            where ct.recording_mbid = l2.recording_mbid and ${sql.unsafe(trackLiveSql('lt.audio_file_id'))} order by lt.id limit 1),
          (select lt.id from recordings rec join local_tracks lt on lt.recording_id = rec.id
            where rec.mbid = l2.recording_mbid and ${sql.unsafe(trackLiveSql('lt.audio_file_id'))} order by lt.id limit 1)) as id
          from likes l2
         where l2.user_id = ${userId} and l2.kind = 'song' and l2.recording_mbid is not null
           and (l2.local_track_id is null or not exists (
             select 1 from local_tracks x where x.id = l2.local_track_id and ${sql.unsafe(trackLiveSql('x.audio_file_id'))}))
      ) t
     where l.id = t.like_id and t.id is not null
       and not exists (select 1 from likes o where o.user_id = ${userId} and o.kind = 'song' and o.local_track_id = t.id)`;
  await sql`
    update likes l set release_group_id = la.release_group_id
      from local_albums la
     where l.user_id = ${userId} and l.kind = 'album' and l.release_group_id is null and la.id = l.local_album_id and la.release_group_id is not null
       and not exists (select 1 from likes o where o.user_id = ${userId} and o.kind = 'album' and o.release_group_id = la.release_group_id)`;
  await sql`delete from likes where user_id = ${userId} and kind = 'album' and release_group_id is null and local_album_id is null`;
  await sql`delete from like_removals where user_id = ${userId} and removed_at < now() - interval '7 days'`;
}

/** Every live local track a person's song likes match (each copy of a liked recording). */
export function likedTrackIdsSql(sql: Sql | Tx, userId: string) {
  return sql`
    select lt.id from likes l join local_tracks lt on lt.id = l.local_track_id
     where l.user_id = ${userId} and l.kind = 'song'
    union
    select lt.id from likes l join canonical_tracks ct on ct.recording_mbid = l.recording_mbid join local_tracks lt on lt.canonical_track_id = ct.id
     where l.user_id = ${userId} and l.kind = 'song' and l.recording_mbid is not null
    union
    select lt.id from likes l join recordings rec on rec.mbid = l.recording_mbid join local_tracks lt on lt.recording_id = rec.id
     where l.user_id = ${userId} and l.kind = 'song' and l.recording_mbid is not null`;
}

/** Every local album a person's album likes match (each copy of a liked release group). */
export function likedAlbumIdsSql(sql: Sql | Tx, userId: string) {
  return sql`
    select la.id from likes l join local_albums la on la.release_group_id = l.release_group_id
     where l.user_id = ${userId} and l.kind = 'album' and l.release_group_id is not null
    union
    -- an album whose release group is known only through its release
    select la.id from likes l join releases r on r.release_group_id = l.release_group_id join local_albums la on la.release_id = r.id
     where l.user_id = ${userId} and l.kind = 'album' and l.release_group_id is not null and la.release_group_id is null
    union
    select l.local_album_id from likes l where l.user_id = ${userId} and l.kind = 'album' and l.local_album_id is not null`;
}

export async function likeKeys(sql: Sql, userId: string): Promise<LikeKeysView> {
  await healLikes(sql, userId);
  const songs = await sql<Array<{ id: string }>>`select id::text as id from (${likedTrackIdsSql(sql, userId)}) s`;
  const albums = await sql<Array<{ id: string }>>`select id::text as id from (${likedAlbumIdsSql(sql, userId)}) a`;
  const artists = await sql<Array<{ id: string }>>`select artist_id::text as id from likes where user_id = ${userId} and kind = 'artist'`;
  return { songs: songs.map((r) => r.id), albums: albums.map((r) => r.id), artists: artists.map((r) => r.id) };
}

/** Liked songs, newest like first: each at its own track, else at a live song of the same recording, else Missing. */
export async function likedSongs(sql: Sql, userId: string): Promise<LikedSongsView> {
  await healLikes(sql, userId);
  const rows = await sql<Array<{
    id: string; track_id: string | null; album_id: string | null; title: string | null; artist: string | null; album: string | null;
    duration_ms: number | null; liked_at: Date; has_art: boolean; artist_id: string | null; artist_name: string | null;
  }>>`
    select l.id::text as id, lt.id::text as track_id, lt.local_album_id::text as album_id,
           coalesce(nullif(lt.title_guess, ''), ct.title, l.title, 'Untitled') as title,
           coalesce(lt.artist_guess, la.artist_guess, l.artist) as artist,
           coalesce(r.title, la.title_guess, l.album) as album,
           coalesce(lt.duration_ms, ct.length_ms) as duration_ms,
           l.liked_at,
           exists (select 1 from images im where im.local_album_id = lt.local_album_id and im.kind = 'front') as has_art,
           ar.id as artist_id, ar.name as artist_name
      from likes l
      left join local_tracks lt on lt.id = l.local_track_id and ${sql.unsafe(trackLiveSql('lt.audio_file_id'))}
      left join canonical_tracks ct on ct.id = lt.canonical_track_id
      left join local_albums la on la.id = lt.local_album_id
      left join releases r on r.id = la.release_id
      left join lateral (
        select rga.artist_id::text as id, coalesce(nullif(rga.credited_name, ''), a.name) as name
          from release_group_artists rga join artists a on a.id = rga.artist_id
         where rga.release_group_id = coalesce(la.release_group_id, r.release_group_id) order by rga.position limit 1) ar on true
     where l.user_id = ${userId} and l.kind = 'song'
     order by l.liked_at desc, l.id`;
  const items = rows.map((r): LikedSongView => ({
    id: r.id,
    localTrackId: r.track_id,
    albumId: r.track_id ? r.album_id : null,
    title: r.title ?? 'Untitled',
    artist: r.artist,
    album: r.album,
    coverUrl: r.track_id && r.album_id && r.has_art ? `/api/v1/images/album/${r.album_id}` : null,
    durationMs: r.duration_ms,
    likedAt: new Date(r.liked_at).toISOString(),
    artistLink: r.track_id && r.artist_id && r.artist_name ? { id: r.artist_id, name: r.artist_name } : null,
  }));
  const covers: string[] = [];
  for (const it of items) {
    if (it.coverUrl && !covers.includes(it.coverUrl)) covers.push(it.coverUrl);
    if (covers.length === 4) break;
  }
  return {
    count: items.length,
    durationMs: items.reduce((n, i) => n + (i.localTrackId ? i.durationMs ?? 0 : 0), 0),
    covers,
    items,
  };
}

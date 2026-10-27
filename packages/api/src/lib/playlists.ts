/**
 * Playlists (the playlists module, 0056): each person's private lists. Every
 * query is scoped to the person (user_id); a list that is not theirs is not
 * found. Items keep a snapshot of the track (title, artist, album, MBIDs,
 * disc and track) so an export can be matched again elsewhere and a track
 * that left the library still has a name ("Missing").
 */
import type postgres from 'postgres';
import { normalizeKey, pickByNames, type MatchCandidate, type ParsedItem, type ParsedPlaylist } from '@tagave/core/playlists';
import {
  PLAYLIST_FILE_FORMAT, PLAYLIST_FILE_VERSION,
  type PlaylistFile, type PlaylistImportResult, type PlaylistItemView, type PlaylistSummary, type PlaylistView,
} from '@tagave/shared';

type Sql = postgres.Sql<any>;
type Tx = postgres.TransactionSql<any>;

const cover = (albumId: string | null, hasArt: boolean) => (albumId && hasArt ? `/api/v1/images/album/${albumId}` : null);

interface Snapshot {
  id: string;
  album_id: string;
  title: string;
  artist: string | null;
  album: string | null;
  album_artist: string | null;
  disc_no: number;
  track_no: number | null;
  duration_ms: number | null;
  recording_mbid: string | null;
  release_mbid: string | null;
}

/** What a track is now, for the item that will point at it. */
async function snapshots(sql: Sql | Tx, ids: readonly string[]): Promise<Map<string, Snapshot>> {
  if (ids.length === 0) return new Map();
  const rows = await sql<Snapshot[]>`
    select lt.id::text as id, la.id::text as album_id,
           coalesce(nullif(lt.title_guess, ''), ct.title, 'Untitled') as title,
           coalesce(lt.artist_guess, la.artist_guess) as artist,
           coalesce(r.title, la.title_guess) as album,
           la.artist_guess as album_artist,
           coalesce(lt.disc_no, 1) as disc_no,
           coalesce(ct.position, lt.track_no) as track_no,
           coalesce(lt.duration_ms, ct.length_ms) as duration_ms,
           coalesce(ct.recording_mbid::text, rec.mbid::text) as recording_mbid,
           coalesce(r.mbid::text, la.embedded_mbid::text) as release_mbid
      from local_tracks lt
      join local_albums la on la.id = lt.local_album_id
      left join releases r on r.id = la.release_id
      left join canonical_tracks ct on ct.id = lt.canonical_track_id
      left join recordings rec on rec.id = lt.recording_id
     where lt.id = any(${[...new Set(ids)]}::uuid[])`;
  return new Map(rows.map((r) => [r.id, r]));
}

/** An album's tracks, in disc and track order. */
export async function albumTrackIds(sql: Sql | Tx, albumId: string): Promise<string[]> {
  const rows = await sql<Array<{ id: string }>>`
    select lt.id::text as id from local_tracks lt join audio_files af on af.id = lt.audio_file_id
     where lt.local_album_id = ${albumId}
     order by coalesce(lt.disc_no, 1), lt.track_no nulls last, af.rel_path`;
  return rows.map((r) => r.id);
}

async function owned(sql: Sql | Tx, userId: string, id: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const [row] = await sql`select 1 from playlists where id = ${id} and user_id = ${userId}`;
  return !!row;
}

/** Appends tracks (in the order given) to a list; ids not in the library are skipped. Returns how many were added. */
async function append(tx: Tx, playlistId: string, trackIds: readonly string[]): Promise<number> {
  const snap = await snapshots(tx, trackIds);
  const [{ next } = { next: 0 }] = await tx<Array<{ next: number }>>`select coalesce(max(position) + 1, 0)::int as next from playlist_items where playlist_id = ${playlistId}`;
  const rows = trackIds.map((id) => snap.get(id)).filter((s): s is Snapshot => !!s).map((s, i) => ({
    playlist_id: playlistId, position: next + i, local_track_id: s.id, recording_mbid: s.recording_mbid, release_mbid: s.release_mbid,
    disc_no: s.disc_no, track_no: s.track_no, title: s.title, artist: s.artist, album: s.album, duration_ms: s.duration_ms,
  }));
  for (let i = 0; i < rows.length; i += 500) await tx`insert into playlist_items ${tx(rows.slice(i, i + 500))}`;
  if (rows.length) await tx`update playlists set updated_at = now() where id = ${playlistId}`;
  return rows.length;
}

export async function listPlaylists(sql: Sql, userId: string): Promise<PlaylistSummary[]> {
  const rows = await sql<Array<{ id: string; name: string; updated_at: Date; tracks: number; duration_ms: number; covers: string[] | null }>>`
    select p.id::text as id, p.name, p.updated_at,
           (select count(*)::int from playlist_items i where i.playlist_id = p.id) as tracks,
           (select coalesce(sum(i.duration_ms), 0)::bigint from playlist_items i where i.playlist_id = p.id)::float8 as duration_ms,
           (select array_agg(a.album_id order by a.first) from (
              select lt.local_album_id::text as album_id, min(i.position) as first
                from playlist_items i join local_tracks lt on lt.id = i.local_track_id
               where i.playlist_id = p.id
                 and exists (select 1 from images im where im.local_album_id = lt.local_album_id and im.kind = 'front')
               group by lt.local_album_id order by min(i.position) limit 4) a) as covers
      from playlists p
     where p.user_id = ${userId}
     order by p.updated_at desc, p.name`;
  return rows.map((r) => ({
    id: r.id, name: r.name, tracks: r.tracks, durationMs: Number(r.duration_ms),
    covers: (r.covers ?? []).map((a) => `/api/v1/images/album/${a}`), updatedAt: new Date(r.updated_at).toISOString(),
  }));
}

export async function getPlaylist(sql: Sql, userId: string, id: string): Promise<PlaylistView | null> {
  if (!(await owned(sql, userId, id))) return null;
  const summary = (await listPlaylists(sql, userId)).find((p) => p.id === id)!;
  const items = await sql<Array<{ id: string; local_track_id: string | null; album_id: string | null; title: string; artist: string | null; album: string | null; duration_ms: number | null; has_art: boolean }>>`
    select i.id::text as id, i.local_track_id::text as local_track_id, lt.local_album_id::text as album_id, i.title, i.artist, i.album, i.duration_ms,
           exists (select 1 from images im where im.local_album_id = lt.local_album_id and im.kind = 'front') as has_art
      from playlist_items i left join local_tracks lt on lt.id = i.local_track_id
     where i.playlist_id = ${id}
     order by i.position, i.added_at`;
  return {
    ...summary,
    items: items.map((r): PlaylistItemView => ({
      id: r.id, localTrackId: r.local_track_id, albumId: r.album_id, title: r.title, artist: r.artist, album: r.album,
      coverUrl: cover(r.album_id, r.has_art), durationMs: r.duration_ms,
    })),
  };
}

export async function createPlaylist(sql: Sql, userId: string, name: string, trackIds: readonly string[] = [], source: 'tagave' | 'import' = 'tagave'): Promise<string> {
  return sql.begin(async (tx) => {
    const [row] = await tx<Array<{ id: string }>>`insert into playlists (user_id, name, source) values (${userId}, ${name.trim()}, ${source}) returning id::text as id`;
    await append(tx, row!.id, trackIds);
    return row!.id;
  });
}

export async function addToPlaylist(sql: Sql, userId: string, id: string, add: { trackIds?: string[] | undefined; albumId?: string | undefined }): Promise<number | null> {
  return sql.begin(async (tx) => {
    if (!(await owned(tx, userId, id))) return null;
    await tx`select 1 from playlists where id = ${id} for update`;
    const ids = add.albumId ? await albumTrackIds(tx, add.albumId) : add.trackIds ?? [];
    return append(tx, id, ids);
  });
}

/** Renames, and/or puts the items in the given order (every item id once). */
export async function patchPlaylist(sql: Sql, userId: string, id: string, patch: { name?: string | undefined; order?: string[] | undefined }): Promise<'ok' | 'not_found' | 'bad_order'> {
  return sql.begin(async (tx) => {
    if (!(await owned(tx, userId, id))) return 'not_found';
    await tx`select 1 from playlists where id = ${id} for update`;
    if (patch.order) {
      const current = (await tx<Array<{ id: string }>>`select id::text as id from playlist_items where playlist_id = ${id}`).map((r) => r.id);
      const asked = new Set(patch.order);
      if (asked.size !== patch.order.length || asked.size !== current.length || current.some((c) => !asked.has(c))) return 'bad_order';
      await tx`update playlist_items i set position = o.pos
                 from unnest(${patch.order}::uuid[]) with ordinality as o(id, pos)
                where i.id = o.id and i.playlist_id = ${id}`;
    }
    if (patch.name !== undefined) await tx`update playlists set name = ${patch.name.trim()} where id = ${id}`;
    await tx`update playlists set updated_at = now() where id = ${id}`;
    return 'ok';
  });
}

export async function removePlaylistItem(sql: Sql, userId: string, id: string, itemId: string): Promise<boolean> {
  if (!(await owned(sql, userId, id)) || !/^[0-9a-f-]{36}$/i.test(itemId)) return false;
  const res = await sql`delete from playlist_items where id = ${itemId} and playlist_id = ${id}`;
  if (res.count) await sql`update playlists set updated_at = now() where id = ${id}`;
  return res.count > 0;
}

export async function deletePlaylist(sql: Sql, userId: string, id: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  return (await sql`delete from playlists where id = ${id} and user_id = ${userId}`).count > 0;
}

// ---- export and import ----

/** The export file for some lists: the person's (`userId`), or everyone's (null, with each owner's name). */
export async function exportPlaylists(sql: Sql, scope: { userId: string | null; playlistId?: string }, generator: string): Promise<PlaylistFile> {
  const lists = await sql<Array<{ id: string; name: string; created_at: Date; owner: string | null }>>`
    select p.id::text as id, p.name, p.created_at, coalesce(nullif(u.display_name, ''), u.email) as owner
      from playlists p join users u on u.id = p.user_id
     where (${scope.userId}::uuid is null or p.user_id = ${scope.userId}::uuid)
       and (${scope.playlistId ?? null}::uuid is null or p.id = ${scope.playlistId ?? null}::uuid)
     order by u.created_at, p.created_at`;
  const items = lists.length
    ? await sql<Array<{ playlist_id: string; local_track_id: string | null; recording_mbid: string | null; release_mbid: string | null; disc_no: number | null; track_no: number | null; title: string; artist: string | null; album: string | null; duration_ms: number | null }>>`
        select playlist_id::text as playlist_id, local_track_id::text as local_track_id, recording_mbid, release_mbid, disc_no, track_no, title, artist, album, duration_ms
          from playlist_items where playlist_id = any(${lists.map((l) => l.id)}::uuid[]) order by position, added_at`
    : [];
  // a track still in the library gives its MBIDs as they are now (identified since it was added)
  const live = await snapshots(sql, items.map((i) => i.local_track_id).filter((x): x is string => !!x));
  return {
    format: PLAYLIST_FILE_FORMAT,
    version: PLAYLIST_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    generator,
    playlists: lists.map((l) => ({
      name: l.name,
      ...(scope.userId === null && l.owner ? { owner: l.owner } : {}),
      createdAt: new Date(l.created_at).toISOString(),
      items: items.filter((i) => i.playlist_id === l.id).map((i) => {
        const now = i.local_track_id ? live.get(i.local_track_id) : undefined;
        return {
          recordingMbid: now?.recording_mbid ?? i.recording_mbid,
          releaseMbid: now?.release_mbid ?? i.release_mbid,
          discNo: now?.disc_no ?? i.disc_no,
          trackNo: now?.track_no ?? i.track_no,
          title: i.title,
          artist: i.artist,
          album: i.album,
          durationMs: i.duration_ms,
        };
      }),
    })),
  };
}

/** Finds a track for each entry: recording MBID, release MBID with disc and track, the file's path, then names and length. */
export class TrackMatcher {
  private names: Map<string, MatchCandidate[]> | null = null;
  private paths: Map<string, string> | null = null;
  constructor(private readonly sql: Sql) {}

  async match(item: ParsedItem): Promise<string | null> {
    if (item.recordingMbid && /^[0-9a-f-]{36}$/i.test(item.recordingMbid)) {
      const [row] = await this.sql<Array<{ id: string }>>`
        select lt.id::text as id from local_tracks lt
          left join canonical_tracks ct on ct.id = lt.canonical_track_id
          left join recordings rec on rec.id = lt.recording_id
         where lower(coalesce(ct.recording_mbid::text, rec.mbid::text)) = ${item.recordingMbid.toLowerCase()}
         order by lt.id limit 1`;
      if (row) return row.id;
    }
    if (item.releaseMbid && /^[0-9a-f-]{36}$/i.test(item.releaseMbid) && item.trackNo != null) {
      const [row] = await this.sql<Array<{ id: string }>>`
        select lt.id::text as id from local_tracks lt
          join local_albums la on la.id = lt.local_album_id
          left join releases r on r.id = la.release_id
          left join canonical_tracks ct on ct.id = lt.canonical_track_id
         where lower(coalesce(r.mbid::text, la.embedded_mbid::text)) = ${item.releaseMbid.toLowerCase()}
           and coalesce(lt.disc_no, 1) = ${item.discNo ?? 1}
           and coalesce(ct.position, lt.track_no) = ${item.trackNo}
         order by lt.id limit 1`;
      if (row) return row.id;
    }
    if (item.path) {
      const byPath = await this.byPath(item.path);
      if (byPath) return byPath;
    }
    const key = normalizeKey(item.title);
    if (!key) return null;
    return pickByNames(item, (await this.nameIndex()).get(key) ?? []);
  }

  private async nameIndex(): Promise<Map<string, MatchCandidate[]>> {
    if (this.names) return this.names;
    const rows = await this.sql<Array<{ id: string; title: string | null; artist: string | null; album_artist: string | null; duration_ms: number | null }>>`
      select lt.id::text as id, coalesce(nullif(lt.title_guess, ''), ct.title) as title, coalesce(lt.artist_guess, la.artist_guess) as artist,
             la.artist_guess as album_artist, coalesce(lt.duration_ms, ct.length_ms) as duration_ms
        from local_tracks lt join local_albums la on la.id = lt.local_album_id
        left join canonical_tracks ct on ct.id = lt.canonical_track_id`;
    const index = new Map<string, MatchCandidate[]>();
    for (const r of rows) {
      const k = normalizeKey(r.title);
      if (!k) continue;
      const list = index.get(k) ?? [];
      list.push({ id: r.id, title: r.title, artist: r.artist, albumArtist: r.album_artist, durationMs: r.duration_ms });
      index.set(k, list);
    }
    this.names = index;
    return index;
  }

  /** The last three, then two, segments of the path against the library's relative paths. */
  private async byPath(path: string): Promise<string | null> {
    if (!this.paths) {
      const rows = await this.sql<Array<{ id: string; rel_path: string }>>`
        select lt.id::text as id, af.rel_path from local_tracks lt join audio_files af on af.id = lt.audio_file_id where lt.origin = 'file'`;
      this.paths = new Map();
      for (const r of rows) {
        const segs = r.rel_path.replace(/\\/g, '/').toLowerCase().split('/');
        for (const n of [3, 2]) if (segs.length >= n) this.paths.set(`${n}:${segs.slice(-n).join('/')}`, r.id);
      }
    }
    const segs = path.toLowerCase().split('/').filter(Boolean);
    for (const n of [3, 2]) {
      if (segs.length < n) continue;
      const hit = this.paths.get(`${n}:${segs.slice(-n).join('/')}`);
      if (hit) return hit;
    }
    return null;
  }
}

/** Each list in the file becomes a list of the person's; entries with no track are kept, "Missing". */
export async function importPlaylists(sql: Sql, userId: string, lists: readonly ParsedPlaylist[]): Promise<PlaylistImportResult> {
  const matcher = new TrackMatcher(sql);
  const out: PlaylistImportResult['playlists'] = [];
  for (const list of lists) {
    const matched: Array<string | null> = [];
    for (const item of list.items) matched.push(await matcher.match(item));
    const snap = await snapshots(sql, matched.filter((x): x is string => !!x));
    const id = await sql.begin(async (tx) => {
      const [row] = await tx<Array<{ id: string }>>`insert into playlists (user_id, name, source) values (${userId}, ${(list.name.trim() || 'Imported playlist').slice(0, 200)}, 'import') returning id::text as id`;
      const rows = list.items.map((item, i) => {
        const s = matched[i] ? snap.get(matched[i]!) : undefined;
        return {
          playlist_id: row!.id, position: i, local_track_id: s?.id ?? null,
          recording_mbid: s?.recording_mbid ?? item.recordingMbid ?? null, release_mbid: s?.release_mbid ?? item.releaseMbid ?? null,
          disc_no: s?.disc_no ?? item.discNo ?? null, track_no: s?.track_no ?? item.trackNo ?? null,
          title: (item.title || s?.title || 'Untitled').slice(0, 1000), artist: item.artist ?? s?.artist ?? null, album: item.album ?? s?.album ?? null,
          duration_ms: item.durationMs ?? s?.duration_ms ?? null,
        };
      });
      for (let i = 0; i < rows.length; i += 500) await tx`insert into playlist_items ${tx(rows.slice(i, i + 500))}`;
      return row!.id;
    });
    const hits = matched.filter(Boolean).length;
    out.push({ id, name: list.name, tracks: list.items.length, matched: hits, missing: list.items.length - hits });
  }
  return { playlists: out };
}

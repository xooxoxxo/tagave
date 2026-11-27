/**
 * Albums whose files are offline (vault "tagave - Offline Library Spec" §5):
 * an album's present files sit on one or more scan roots, and an enabled
 * root the folder watch reads `offline` or `unmounted` (scan_roots.reach,
 * 0097) is not online. The album list, album page, search and the artist
 * page add `filesOffline` from these two steps:
 *
 *   notOnlineRoots   the enabled roots that are not online, with since when;
 *                    an empty map (the usual case) means callers add nothing
 *                    and run no second query
 *   albumsOffline    per album, `all` when every present file is on such a
 *                    root, `some` when only part of them is; an album with
 *                    none there is left out
 */
import type postgres from 'postgres';
import type { RootReach } from './musicFolder.js';

type Q = postgres.Sql<any> | postgres.TransactionSql<any>;

export interface NotOnlineRoot {
  reach: RootReach;
  /** when reach last changed; null with no transition recorded */
  since: Date | null;
}

export interface AlbumOffline {
  filesOffline: 'all' | 'some';
  /** ISO 8601: the earliest since of the album's roots that are not online */
  since: string | null;
}

/** Enabled roots whose reach is `offline` or `unmounted`, by root id. */
export async function notOnlineRoots(sql: Q): Promise<Map<string, NotOnlineRoot>> {
  // epoch ms: drizzle makes timestamps come back raw (text) on the shared client
  const rows = await sql<Array<{ id: string; reach: RootReach; since_ms: number | null }>>`
    select id, reach, (extract(epoch from reach_since) * 1000)::float8 as since_ms
      from scan_roots
     where enabled and reach in ('offline', 'unmounted')`;
  return new Map(rows.map((r) => [r.id, { reach: r.reach, since: r.since_ms === null ? null : new Date(r.since_ms) }]));
}

/** Present files of each album by scan root, judged against `roots` (from notOnlineRoots). */
export async function albumsOffline(sql: Q, albumIds: string[], roots: Map<string, NotOnlineRoot>): Promise<Map<string, AlbumOffline>> {
  const out = new Map<string, AlbumOffline>();
  if (albumIds.length === 0 || roots.size === 0) return out;
  const rows = await sql<Array<{ album_id: string; root_id: string }>>`
    select distinct lt.local_album_id as album_id, f.scan_root_id as root_id
      from local_tracks lt
      join files f on f.id = lt.audio_file_id
     where lt.local_album_id = any(${albumIds}::uuid[]) and f.status = 'present'`;
  const byAlbum = new Map<string, string[]>();
  for (const r of rows) byAlbum.set(r.album_id, [...(byAlbum.get(r.album_id) ?? []), r.root_id]);
  for (const [albumId, rootIds] of byAlbum) {
    const away = rootIds.filter((id) => roots.has(id));
    if (away.length === 0) continue;
    const sinces = away.map((id) => roots.get(id)!.since).filter((d): d is Date => d !== null).map((d) => d.getTime());
    out.set(albumId, {
      filesOffline: away.length === rootIds.length ? 'all' : 'some',
      since: sinces.length ? new Date(Math.min(...sinces)).toISOString() : null,
    });
  }
  return out;
}

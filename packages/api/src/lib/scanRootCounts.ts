import { sql } from 'drizzle-orm';

type Counts = Map<string, { albumsFound: number; tracksFound: number }>;

/**
 * Albums and tracks found under each music folder of a library: present
 * files under the root, and the distinct albums those files were clustered
 * into. Roots with nothing in them are absent from the map.
 *
 * Tracks and albums are counted apart: one count(distinct) over the joined
 * rows sorted ~240k rows per request and spilled to disk under load (audit
 * 2026-10-10). Both halves read the narrow indexes from migration 0035
 * (idx_files_present_root, idx_local_tracks_file_album) instead of
 * the files heap; the album half de-duplicates with a hash.
 */
export async function scanRootCounts(db: any, libraryId: string): Promise<Counts> {
  const rows = (await db.execute(sql`
    with tracks as (
      select af.scan_root_id, count(*)::int as tracks
        from files af
       where af.library_id = ${libraryId} and af.status = 'present'
       group by af.scan_root_id
    ), albums as (
      select scan_root_id, count(*)::int as albums
        from (select distinct af.scan_root_id, lt.local_album_id
                from files af
                join local_tracks lt on lt.audio_file_id = af.id
               where af.library_id = ${libraryId} and af.status = 'present'
                 and lt.local_album_id is not null) d
       group by scan_root_id
    )
    select t.scan_root_id::text as root_id, t.tracks, coalesce(a.albums, 0)::int as albums
      from tracks t left join albums a using (scan_root_id)
  `)) as unknown as Array<{ root_id: string; tracks: number; albums: number }>;
  return new Map(rows.map((r) => [r.root_id, { albumsFound: Number(r.albums), tracksFound: Number(r.tracks) }]));
}

/** Counts move only while a scan runs; Settings and the plan page may read them 30 s old. */
const TTL_MS = 30_000;
const cache = new Map<string, { at: number; value: Promise<Counts> }>();

export function cachedScanRootCounts(db: any, libraryId: string): Promise<Counts> {
  const hit = cache.get(libraryId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = scanRootCounts(db, libraryId);
  cache.set(libraryId, { at: Date.now(), value });
  value.catch(() => { if (cache.get(libraryId)?.value === value) cache.delete(libraryId); });
  return value;
}

/** A root added, removed or rescanned from the API: drop the cached counts. */
export function invalidateScanRootCounts(libraryId: string): void {
  cache.delete(libraryId);
}

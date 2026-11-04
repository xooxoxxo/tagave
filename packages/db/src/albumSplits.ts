/**
 * Whole album in one file (0078): the one reading of the detection rule, for
 * gaps.recompute (the Attention list), the album page's Split and the file
 * worker's own check before it touches anything. The rule is
 * @tagave/shared › looksLikeWholeAlbum; this is the same in SQL:
 *
 *   a matched album with exactly one audio file, a FLAC that is present and
 *   not deleted, with no cue track and no .cue in its folder; its release has
 *   more than one track (data and video tracks aside), every length known,
 *   and the file is within max(20 s, 1 %) of their sum.
 *
 * An embedded CUESHEET block is not in the database: the worker checks the
 * file itself (metaflac) before it plans.
 */
import type postgres from 'postgres';

type Sql = postgres.Sql<any> | postgres.TransactionSql<any>;

/** @tagave/shared › ONE_FILE_TOLERANCE_MS and _SHARE (this package does not depend on shared). */
const TOLERANCE_MS = 20_000;
const TOLERANCE_SHARE = 0.01;

export interface OneFileAlbum {
  albumId: string;
  fileId: string;
  /** the file's one track row (the player streams it) */
  localTrackId: string;
  scanRootId: string;
  relPath: string;
  fileMs: number;
  releaseId: string;
  releaseMs: number;
  tracks: number;
}

/** The library's albums that fit the rule; one album when `albumId` is given. */
export async function oneFileAlbums(sql: Sql, libraryId: string, albumId?: string): Promise<OneFileAlbum[]> {
  const rows = await sql<Array<OneFileAlbum & { fileMs: number | string; releaseMs: number | string }>>`
    select la.id::text as "albumId", f.id::text as "fileId", t.track_id::text as "localTrackId",
           f.scan_root_id::text as "scanRootId", f.rel_path as "relPath", f.duration_ms as "fileMs",
           la.release_id::text as "releaseId", ct.total_ms as "releaseMs", ct.n as tracks
      from local_albums la
      join lateral (
        select count(distinct lt.audio_file_id)::int as files, (array_agg(lt.audio_file_id))[1] as file_id,
               (array_agg(lt.id))[1] as track_id, coalesce(bool_or(lt.origin = 'cue'), false) as has_cue
          from local_tracks lt where lt.local_album_id = la.id) t on t.files = 1 and not t.has_cue
      join files f on f.id = t.file_id
      join lateral (
        select count(*)::int as n, coalesce(sum(c.length_ms), 0)::bigint as total_ms,
               count(*) filter (where c.length_ms is null or c.length_ms <= 0)::int as unknown
          from canonical_tracks c
         where c.release_id = la.release_id and not coalesce(c.is_data_track, false) and not coalesce(c.is_video, false)) ct
        on ct.n > 1 and ct.unknown = 0
     where la.library_id = ${libraryId}
       and la.state = 'matched' and la.release_id is not null
       ${albumId ? sql`and la.id = ${albumId}` : sql``}
       and f.status = 'present' and lower(f.rel_path) like '%.flac'
       and f.duration_ms is not null
       and abs(f.duration_ms - ct.total_ms) <= greatest(${TOLERANCE_MS}::bigint, ct.total_ms * ${TOLERANCE_SHARE}::numeric)
       and not exists (select 1 from file_deletions fd where fd.file_id = f.id)
       and not exists (
         select 1 from sidecar_files s
          where s.scan_root_id = f.scan_root_id and s.kind = 'cue'
            and (case when strpos(s.rel_path, '/') = 0 then '' else regexp_replace(s.rel_path, '/[^/]*$', '') end)
              = (case when strpos(f.rel_path, '/') = 0 then '' else regexp_replace(f.rel_path, '/[^/]*$', '') end))
     order by la.id`;
  return rows.map((r) => ({ ...r, fileMs: Number(r.fileMs), releaseMs: Number(r.releaseMs) }));
}

/** Roots the file worker may write in: enabled, writable by the owner's setting, and its own write check passed (as Trash). */
export async function writableRootIds(sql: Sql, libraryId: string): Promise<Set<string>> {
  const rows = await sql<Array<{ id: string }>>`
    select id::text as id from scan_roots
     where library_id = ${libraryId} and enabled and writable and probe_writable is true`;
  return new Set(rows.map((r) => r.id));
}

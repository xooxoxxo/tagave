import type postgres from 'postgres';

export interface FlacUpgradeSource {
  releaseId: string;
  releaseMbid: string;
  groupMbid: string;
  artistMbid: string;
  artistName: string;
  scanRootId: string;
  root: string;
  files: Array<{ id: string; rel: string; disc: number; position: number; flac: boolean }>;
}

/** Select a complete matched album with one file per track on a writable music folder. */
export async function flacUpgradeSource(sql: postgres.Sql | postgres.TransactionSql, libraryId: string, albumId: string): Promise<FlacUpgradeSource | null> {
  const rows = await sql<Array<{
    releaseId: string; releaseMbid: string; groupMbid: string; artistMbid: string; artistName: string;
    scanRootId: string; root: string; id: string; rel: string; disc: number; position: number;
    flac: boolean; usable: boolean; matched: boolean; expected: number;
  }>>`
    select r.id as "releaseId", r.mbid as "releaseMbid", rg.mbid as "groupMbid", a.mbid as "artistMbid", a.name as "artistName",
      sr.id as "scanRootId", sr.path as root, f.id, f.rel_path as rel,
      coalesce(ct.medium_no, lt.disc_no, 1) as disc, coalesce(ct.position, lt.track_no, 0) as position,
      (lower(coalesce(f.codec, '')) = 'flac' or lower(coalesce(f.container, '')) = 'flac') as flac,
      (sr.enabled and sr.writable and sr.probe_writable is true and f.status = 'present' and fd.file_id is null
       and lt.origin = 'file') as usable,
      (ct.release_id = r.id or lt.canonical_track_id is null) as matched,
      (select count(*)::int from canonical_tracks t where t.release_id = r.id
       and not coalesce(t.is_data_track, false) and not coalesce(t.is_video, false)) as expected
    from local_albums la
    join releases r on r.id = la.release_id
    join release_groups rg on rg.id = r.release_group_id
    join lateral (select artist_id from release_group_artists where release_group_id = rg.id order by position limit 1) rga on true
    join artists a on a.id = rga.artist_id
    join local_tracks lt on lt.local_album_id = la.id
    join files f on f.id = lt.audio_file_id
    join scan_roots sr on sr.id = f.scan_root_id
    left join canonical_tracks ct on ct.id = lt.canonical_track_id
    left join file_deletions fd on fd.file_id = f.id
    where la.id = ${albumId} and la.library_id = ${libraryId}
      and r.mbid is not null and rg.mbid is not null and a.mbid is not null
    order by disc, position, f.id
  `;
  const first = rows[0];
  if (!first || rows.length !== first.expected || rows.every((row) => row.flac)) return null;
  if (rows.some((row) => !row.usable || !row.matched || row.position < 1 || row.scanRootId !== first.scanRootId)) return null;
  if (new Set(rows.map((row) => row.id)).size !== rows.length ||
      new Set(rows.map((row) => `${row.disc}:${row.position}`)).size !== rows.length) return null;
  const { releaseId, releaseMbid, groupMbid, artistMbid, artistName, scanRootId, root } = first;
  const files = rows.map(({ id, rel, disc, position, flac }) => ({ id, rel, disc, position, flac }));
  return { releaseId, releaseMbid, groupMbid, artistMbid, artistName, scanRootId, root, files };
}

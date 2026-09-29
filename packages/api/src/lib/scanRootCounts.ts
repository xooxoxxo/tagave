import { sql } from 'drizzle-orm';

/**
 * Albums and tracks found under each music folder of a library: present
 * files under the root, and the distinct albums those files were clustered
 * into. Roots with nothing in them are absent from the map.
 */
export async function scanRootCounts(
  db: any,
  libraryId: string,
): Promise<Map<string, { albumsFound: number; tracksFound: number }>> {
  const rows = (await db.execute(sql`
    select af.scan_root_id::text as root_id,
           count(distinct af.id)::int as tracks,
           count(distinct lt.local_album_id)::int as albums
      from audio_files af
      left join local_tracks lt on lt.audio_file_id = af.id
     where af.library_id = ${libraryId} and af.status = 'present'
     group by af.scan_root_id
  `)) as unknown as Array<{ root_id: string; tracks: number; albums: number }>;
  return new Map(rows.map((r) => [r.root_id, { albumsFound: Number(r.albums), tracksFound: Number(r.tracks) }]));
}

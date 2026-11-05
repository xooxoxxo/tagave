/**
 * The album-level gaps Library care lists, recomputed for the albums an
 * operation touched (rr85) or for the whole library (gaps.recompute's nightly
 * run). One definition for both, so the api can put Library care right in the
 * same request that changed an album ("Treat as one album", split back, …)
 * and the worker's scoped and unscoped runs never disagree with it.
 *
 *   incomplete_album  a matched album with fewer tracks than its release
 *   duplicate         several albums on one release group
 *   one_file_album    a whole album in one FLAC (0078, see albumSplits.ts)
 *   gone              any album-subject gap of an album that was removed or
 *                     whose every file is deleted is resolved
 *
 * Cheap set-based SQL; the per-album quality flags (tag lint) stay in the
 * worker's gaps.recompute, which the caller queues for the same albums.
 *
 * Upserts keep the owner's decision (keepGapDecision): a hidden gap stays
 * hidden and a task stays a task while its condition holds; a gap whose
 * condition is gone is resolved.
 */
import type postgres from 'postgres';
import { albumLiveSql } from './deletions.js';
import { oneFileAlbums } from './albumSplits.js';

type Sql = postgres.Sql<any> | postgres.TransactionSql<any>;

/** @tagave/shared › ONE_FILE_ALBUM_GAP (this package does not depend on shared). */
const ONE_FILE_ALBUM_GAP = 'one_file_album';

/**
 * The shared ON CONFLICT tail of every gap upsert (natural key 0032:
 * library, kind, subject_type, subject_id, flag). A gap that still holds
 * keeps the owner's decision; a resolved gap whose condition came back opens
 * again as a fresh gap (no longer a task).
 */
export function keepGapDecision(sql: Sql) {
  return sql`
    on conflict (library_id, kind, subject_type, subject_id, flag)
    do update set details = excluded.details,
                  state = case when gaps.state in ('dismissed', 'todo') then gaps.state else 'open' end,
                  accepted_at = case when gaps.state = 'resolved' then null else gaps.accepted_at end,
                  resolved_at = null`;
}

/**
 * Recompute the album-level gaps of these albums, or of every album of the
 * library when `albumIds` is null. Pass every album the operation touched:
 * the ones that changed and the ones it removed (their gaps resolve).
 */
export async function recomputeAlbumGaps(sql: Sql, libraryId: string, albumIds: readonly string[] | null): Promise<void> {
  const all = albumIds === null;
  const ids = [...new Set(albumIds ?? [])];
  if (!all && ids.length === 0) return;
  const live = sql.unsafe(albumLiveSql('la.id'));

  // --- incomplete: matched, fewer local tracks than the release
  await sql`
    insert into gaps (library_id, kind, subject_type, subject_id, details, state)
    select ${libraryId}, 'incomplete_album', 'local_album', la.id,
           jsonb_build_object(
             'have', la.track_count,
             'want', r.track_count,
             'missing', missing.tracks
           ),
           'open'
    from local_albums la
    join releases r on r.id = la.release_id
    join lateral (
      select jsonb_agg(jsonb_build_object(
               'disc', ct.medium_no, 'position', ct.position,
               'title', ct.title, 'lengthMs', ct.length_ms)
             order by ct.medium_no, ct.position) as tracks
      from canonical_tracks ct
      where ct.release_id = r.id
        and not ct.is_data_track and not ct.is_video
        and not exists (
          select 1 from local_tracks lt
          where lt.local_album_id = la.id
            and coalesce(lt.disc_no, 1) = coalesce(ct.medium_no, 1)
            and lt.track_no = ct.position)
    ) missing on true
    where la.library_id = ${libraryId}
      and (${all} or la.id = any(${ids}::uuid[]))
      and la.state = 'matched'
      and r.track_count is not null
      and la.track_count < r.track_count
      and ${live}
    ${keepGapDecision(sql)}`;
  await sql`
    update gaps g set state = 'resolved', resolved_at = now()
    where g.library_id = ${libraryId} and g.kind = 'incomplete_album' and g.state != 'resolved'
      and (${all} or g.subject_id = any(${ids}::uuid[]))
      and not exists (
        select 1 from local_albums la
        join releases r on r.id = la.release_id
        where la.id = g.subject_id and la.state = 'matched'
          and r.track_count is not null and la.track_count < r.track_count
          and ${live})`;

  // --- duplicate: several live albums on one release group. Scoped, the
  // groups are the albums' own and those of every duplicate gap that lists
  // one of them (an album that left its group, or is gone).
  const groups = all ? null : (await sql<Array<{ id: string }>>`
    select distinct release_group_id::text as id from local_albums
     where id = any(${ids}::uuid[]) and release_group_id is not null
    union
    select distinct g.subject_id::text from gaps g
     where g.library_id = ${libraryId} and g.kind = 'duplicate'
       and g.details->'albumIds' ?| ${ids}::text[]`).map((r) => r.id);
  if (all || groups!.length > 0) {
    const scope = groups ?? [];
    await sql`
      insert into gaps (library_id, kind, subject_type, subject_id, details, state)
      select ${libraryId}, 'duplicate', 'release_group', d.release_group_id,
             jsonb_build_object('albumIds', d.ids, 'count', d.n), 'open'
      from (
        select la.release_group_id, count(*) as n, jsonb_agg(la.id order by la.id) as ids
        from local_albums la
        where la.library_id = ${libraryId} and la.release_group_id is not null and la.state != 'ignored'
          and (${all} or la.release_group_id = any(${scope}::uuid[]))
          and ${live}
        group by la.release_group_id having count(*) > 1
      ) d
      ${keepGapDecision(sql)}`;
    await sql`
      update gaps g set state = 'resolved', resolved_at = now()
      where g.library_id = ${libraryId} and g.kind = 'duplicate' and g.state != 'resolved'
        and (${all} or g.subject_id = any(${scope}::uuid[]))
        and (select count(*) from local_albums la
             where la.library_id = ${libraryId} and la.release_group_id = g.subject_id
               and la.state != 'ignored' and ${live}) < 2`;
  }

  // --- whole album in one file: mark-and-sweep, as the quality flags. The
  // upsert clears the mark on albums that still fit, the rest resolve.
  await sql`
    update gaps set resolved_at = now()
    where library_id = ${libraryId} and kind = ${ONE_FILE_ALBUM_GAP} and state != 'resolved'
      and (${all} or subject_id = any(${ids}::uuid[]))`;
  const oneFile = all
    ? await oneFileAlbums(sql, libraryId)
    : (await Promise.all(ids.map((id) => oneFileAlbums(sql, libraryId, id)))).flat();
  if (oneFile.length > 0) {
    await sql`
      insert into gaps (library_id, kind, subject_type, subject_id, details, state)
      select ${libraryId}, ${ONE_FILE_ALBUM_GAP}, 'local_album', u.id, u.d::jsonb, 'open'
        from unnest(${oneFile.map((a) => a.albumId)}::uuid[],
                    ${oneFile.map((a) => JSON.stringify({ fileId: a.fileId, fileMs: a.fileMs, releaseMs: a.releaseMs, tracks: a.tracks }))}::text[]) as u(id, d)
      ${keepGapDecision(sql)}`;
  }
  await sql`
    update gaps set state = 'resolved'
    where library_id = ${libraryId} and kind = ${ONE_FILE_ALBUM_GAP} and state != 'resolved' and resolved_at is not null
      and (${all} or subject_id = any(${ids}::uuid[]))`;

  // --- gone: an album that was merged away, removed or deleted has nothing
  // left to fix (its quality flags included).
  await sql`
    update gaps g set state = 'resolved', resolved_at = now()
    where g.library_id = ${libraryId} and g.subject_type = 'local_album' and g.state != 'resolved'
      and (${all} or g.subject_id = any(${ids}::uuid[]))
      and not exists (select 1 from local_albums la where la.id = g.subject_id and ${live})`;
}

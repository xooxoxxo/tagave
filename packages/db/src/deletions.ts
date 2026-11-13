/**
 * Deleted songs and albums (0073 file_deletions) leave the library at once:
 * every reader that lists, counts, searches or plays them filters with these
 * predicates. Plain SQL text, so drizzle (`sql.raw`) and postgres.js
 * (`sql.unsafe`) readers share one definition. The argument is a column
 * reference of the caller's query (a constant, never user input).
 */

/** True when the file (an audio_file_id / files.id expression) has a deletion row. */
export function fileDeletedSql(fileId: string): string {
  return `exists (select 1 from file_deletions fd_ where fd_.file_id = ${fileId})`;
}

/** True when the track's file is not deleted. */
export function trackLiveSql(fileId: string): string {
  return `not ${fileDeletedSql(fileId)}`;
}

/**
 * True when the album (a local_albums.id expression) has tracks and every one
 * of them is deleted. An album with no deleted track answers on the first
 * probe, so the cost on a library without deletions is one index lookup.
 */
export function albumDeletedSql(albumId: string): string {
  return `(exists (select 1 from local_tracks dlt_ join file_deletions dfd_ on dfd_.file_id = dlt_.audio_file_id where dlt_.local_album_id = ${albumId})
    and not exists (select 1 from local_tracks dlt2_ where dlt2_.local_album_id = ${albumId}
      and not exists (select 1 from file_deletions dfd2_ where dfd2_.file_id = dlt2_.audio_file_id)))`;
}

/** The album is in the library: not every one of its tracks is deleted. */
export function albumLiveSql(albumId: string): string {
  return `not ${albumDeletedSql(albumId)}`;
}

/**
 * Advisory lock key for one local album's cluster key. Whoever creates an
 * album and gives it its tracks holds it (pg_advisory_xact_lock over
 * hashtextextended(key, 0)) until both commit: the worker's cluster.dir and
 * the api's split-by-format. The worker's zero-track sweep takes it before it
 * deletes an album of that key, so an album being filled is never seen empty
 * and removed.
 */
export function albumKeyLock(libraryId: string, clusterKey: string): string {
  return `album-key:${libraryId}\n${clusterKey}`;
}

/**
 * Namespace of the per-album lock on matching evidence. Every transaction
 * that writes an album's candidates or its album evidence (identification,
 * a pasted edition, the evidence rebuild) takes
 * pg_advisory_xact_lock(hashtextextended(albumEvidenceLock(id), 0)) first,
 * so two of them never interleave and one built from a stale read can see
 * that it is stale.
 */
export const ALBUM_EVIDENCE_LOCK_NAMESPACE = 'album-evidence';

export function albumEvidenceLock(albumId: string): string {
  return `${ALBUM_EVIDENCE_LOCK_NAMESPACE}:${albumId}`;
}

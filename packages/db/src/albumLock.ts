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

/**
 * Every pg-boss queue the workers serve. The worker creates these at start;
 * the worker check (doctor, System status, setup) asks whether the live
 * workers together serve all of them, which is what "enough workers" means
 * on a single-worker install and on a split one alike.
 */
export const WORKER_QUEUES = [
  'scan.root', 'scan.dir', 'scan.sweep', 'roots.validate', 'scan.parse', 'cluster.dir', 'cluster.repairDiscs',
  'identify.album', 'identify.acoustid', 'identify.sweep', 'edition.add',
  'enrich.release', 'enrich.sweep', 'editions.fetch', 'art.fetch', 'art.sweep', 'art.thumb', 'art.thumbSweep', 'gaps.recompute', 'queue.autoaccept',
  'collection.sync', 'collection.push', 'collection.remove', 'reviews.fetch',
  'artists.resolve', 'artists.enrich', 'artists.refresh', 'artist.refresh',
  'tags.preview', 'tags.apply', 'tags.revert', 'facets.refresh',
  'fingerprint.album', 'fingerprint.sweep', 'acoustid.lookup', 'tracks.link',
  'cache.purge', 'mc.purge', 'connections.pull', 'listenLinks.resolve',
] as const;

/**
 * Queues a worker works along with another one, not by their own name in
 * TAGAVE_QUEUES: folder checks with scans, editions and the Discogs
 * collection with release enrichment.
 */
export const QUEUES_RIDING_WITH: Readonly<Record<string, string>> = {
  'roots.validate': 'scan.root',
  'editions.fetch': 'enrich.release',
  'collection.sync': 'enrich.release',
  'collection.push': 'enrich.release',
  'collection.remove': 'enrich.release',
  // nightly provider_cache cleanup: database-only upkeep, on the facets worker
  'cache.purge': 'facets.refresh',
  // daily Music Connections tombstone cleanup: database-only, same worker
  'mc.purge': 'facets.refresh',
  // Music Connections pulls from linked apps (spec §4: on the identify worker)
  'connections.pull': 'identify.album',
  // Listen elsewhere's link lookups: MusicBrainz shares identify's 1 req/s budget
  'listenLinks.resolve': 'identify.album',
  // a release the owner pasted on Review matches: fetched and scored like identify's
  'edition.add': 'identify.album',
  // cover thumbnails rebuilt from the originals art.fetch keeps on its cache volume
  'art.thumb': 'art.fetch',
  'art.thumbSweep': 'art.fetch',
};

/** The names TAGAVE_QUEUES chooses from: each needs some live worker. */
export const GATED_QUEUES: readonly string[] = WORKER_QUEUES.filter((q) => !(q in QUEUES_RIDING_WITH));

/** What a queue does, in words the owner knows. */
function queueGroup(queue: string): string {
  if (/^(scan|roots|cluster)\./.test(queue)) return 'reading music folders';
  if (/^(identify|fingerprint|acoustid)\./.test(queue) || queue === 'queue.autoaccept') return 'identifying albums';
  if (/^(enrich|editions|art|reviews|artists?|tracks|gaps)\./.test(queue)) return 'fetching album details';
  if (queue.startsWith('tags.')) return 'tag changes';
  if (queue.startsWith('collection.')) return 'the Discogs collection';
  return 'background upkeep';
}

/**
 * The kinds of work no live worker serves, in plain words (empty when every
 * queue is served). Each entry is one worker's served queues; '*' serves all.
 */
export function unservedWork(served: ReadonlyArray<readonly string[]>): string[] {
  if (served.some((qs) => qs.includes('*'))) return [];
  const all = new Set(served.flat());
  const missing = GATED_QUEUES.filter((q) => !all.has(q));
  return [...new Set(missing.map(queueGroup))];
}

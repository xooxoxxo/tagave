/**
 * Every pg-boss queue the workers serve. The worker creates these at start;
 * the worker check (doctor, System status, setup) asks whether the live
 * workers together serve all of them, which is what "enough workers" means
 * on a single-worker install and on a split one alike.
 */
export const WORKER_QUEUES = [
  'scan.root', 'scan.dir', 'scan.sweep', 'roots.validate', 'scan.parse', 'cluster.dir', 'cluster.repairDiscs', 'cluster.backfillLoose', 'files.backfillDigest',
  'identify.album', 'identify.acoustid', 'identify.sweep', 'edition.add',
  'enrich.release', 'enrich.sweep', 'editions.fetch', 'art.fetch', 'art.sweep', 'art.thumb', 'art.thumbSweep', 'gaps.recompute', 'queue.autoaccept',
  'collection.sync', 'collection.push', 'collection.remove', 'reviews.fetch',
  'artists.resolve', 'artists.enrich', 'artists.refresh', 'artist.refresh',
  'tags.preview', 'tags.apply', 'tags.revert', 'facets.refresh',
  'fingerprint.album', 'fingerprint.sweep', 'acoustid.lookup', 'tracks.link',
  'cache.purge', 'mc.purge', 'connections.pull', 'listenLinks.resolve', 'similarArtists.fetch', 'files.trash', 'files.split', 'files.move', 'lidarr.poll', 'lidarr.get', 'pool.scan',
  'dj.analyze',
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
  // Similar artists: ListenBrainz (and Last.fm) by artist MBID, outside work like the one above
  'similarArtists.fetch': 'identify.album',
  // Lidarr (Get missing albums): calls to the owner's Lidarr, outside work like the two above
  'lidarr.poll': 'identify.album',
  'lidarr.get': 'identify.album',
  // the drop pool: reads the pool folder and identifies what is dropped (MusicBrainz, identify's pace)
  'pool.scan': 'identify.album',
  // a release the owner pasted on Review matches: fetched and scored like identify's
  'edition.add': 'identify.album',
  // cover thumbnails rebuilt from the originals art.fetch keeps on its cache volume
  'art.thumb': 'art.fetch',
  'art.thumbSweep': 'art.fetch',
  // core_tags_digest backfill: tag logic, rides with the parser
  'files.backfillDigest': 'scan.parse',
  // folders of loose files from before untagged files formed albums: rides with the clusterer
  'cluster.backfillLoose': 'cluster.dir',
  // Deleting: moves into and out of the trash folder; rides with the tag writer, the other job that writes the music folder
  'files.trash': 'tags.apply',
  // Whole album in one file: one FLAC per track, the source into the trash; with the tag writer too
  'files.split': 'tags.apply',
  // Move to album: tags written and files moved into another album's folder; with the tag writer too
  'files.move': 'tags.apply',
  // DJ analysis: ffmpeg decodes each file once; on the file worker, with the fingerprints (the other decode of every file)
  'dj.analyze': 'fingerprint.album',
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

import { PgBoss } from 'pg-boss';

let bossSingleton: Promise<PgBoss> | null = null;

type ErrorLogger = { error: (obj: object, msg: string) => void };
let bossLogger: ErrorLogger = { error: (obj, msg) => console.error(msg, obj) };

/** Where pg-boss errors are logged; index.ts points it at the app logger. */
export function setBossLogger(logger: ErrorLogger): void {
  bossLogger = logger;
}

/**
 * pg-boss re-emits its pool's errors (a dropped connection, Postgres
 * restarting) as an 'error' event. An EventEmitter with no 'error' listener
 * throws, so before this the API process exited whenever its database
 * connection dropped (audit 2026-10-10, offender 5). With a listener the
 * error is logged and the pool reconnects on the next query.
 */
export function watchBossErrors(boss: PgBoss, logger?: ErrorLogger): PgBoss {
  boss.on('error', (err: Error) => (logger ?? bossLogger).error({ err }, 'pg-boss error (will reconnect on next use)'));
  return boss;
}

/** Same retry policy the worker applies to every queue (see worker/src/index.ts). */
const QUEUE_RETRY_DEFAULTS = { retryDelay: 60, retryBackoff: true, retryDelayMax: 3600 } as const;

export function getBoss(): Promise<PgBoss> {
  // One start shared by concurrent first callers; a failed start is retried next call.
  bossSingleton ??= startBoss().catch((err) => {
    bossSingleton = null;
    throw err;
  });
  return bossSingleton;
}

async function startBoss(): Promise<PgBoss> {
  const boss = watchBossErrors(new PgBoss(process.env.DATABASE_URL!));
  await boss.start();
  // Queues the API sends to before a worker may have created them. An
  // existing queue keeps its options (the worker owns them).
  for (const q of [
    'identify.album', 'identify.sweep', // identify
    'artists.enrich', // artists
    'collection.sync', 'collection.push', 'collection.remove', // collection
    'roots.validate', 'scan.root', 'enrich.sweep', // library / scan
    'edition.add', 'queue.autoaccept', // review matches
    'art.fetch', 'art.thumb', 'art.thumbSweep', // covers and missing thumbnails
    'connections.pull', // Settings › Modules › Music Connections: Sync now, and the first pull after linking
    'listenLinks.resolve', // Listen elsewhere: an album or artist page asks for its links
    'decider.accept', // accept batches and decider runs (Library care › Review)
    'similarArtists.fetch', // Similar artists: an artist page asks for its list
    'dj.analyze', // DJ: the player asks for its next tracks' analysis, turning the module on starts the sweep
    'files.trash', // Deleting: moves into and out of the trash folder, Empty trash
    'files.upgrade', // Upgrade to FLAC
    'files.embedCover',
    'files.split', // Whole album in one file: the cut points, then the split
    'files.move', // Move to album: the release search, the plan, the move and its undo
  ]) {
    await boss.createQueue(q, q === 'scan.root' ? undefined : QUEUE_RETRY_DEFAULTS);
  }
  // the autotagger's runs: stately from the first send, so the per-library
  // singletonKey holds before a worker has set the queue's other options
  await boss.createQueue('decider.run', { policy: 'stately', ...QUEUE_RETRY_DEFAULTS });
  // the player module's debounced scans (worked by the API itself, see lib/player.ts)
  await boss.createQueue('tags.apply', { policy: 'stately', ...QUEUE_RETRY_DEFAULTS });
  await boss.createQueue('player.scan', { policy: 'stately', ...QUEUE_RETRY_DEFAULTS });
  return boss;
}

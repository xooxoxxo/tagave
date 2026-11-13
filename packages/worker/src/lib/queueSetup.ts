/**
 * The pg-boss queues the worker serves, with the policies and limits each
 * runs under. index.ts applies them at every start; tests that run a worker
 * handler through pg-boss apply the same ones (prepareWorkerQueues).
 */
import type { PgBoss } from 'pg-boss';
import type postgres from 'postgres';
import { WORKER_QUEUES } from '@tagave/core';
import { DECIDER_ACCEPT_EXPIRE_SECONDS, DECIDER_RUN_EXPIRE_SECONDS } from '@tagave/db';

/**
 * Queue policies that make singletonKey mean something. 'stately' keeps one
 * job per key per state (one queued behind one active, so a re-request during
 * a run still runs afterwards); 'exclusive' keeps one per key across both
 * (reviews.fetch is enqueued by a polling album page). Not listed on purpose:
 * cluster.dir — scan.parse re-sends a directory as parse batches land and
 * every send must run; collection.* belong to the collection sync session.
 */
export const QUEUE_POLICIES: Record<string, 'stately' | 'exclusive'> = {
  'reviews.fetch': 'exclusive',
  'editions.fetch': 'stately',
  'enrich.release': 'stately',
  'enrich.sweep': 'stately',
  'art.fetch': 'stately',
  'art.sweep': 'stately',
  'art.thumb': 'stately',
  'art.thumbSweep': 'stately',
  'identify.album': 'stately',
  'identify.acoustid': 'stately',
  'roots.validate': 'stately',
  'scan.root': 'stately',
  'scan.dir': 'stately',
  'scan.sweep': 'stately',
  // Sibling disc folders resolve to one scope; two jobs on it must not interleave.
  'cluster.dir': 'stately',
  // enqueued at every boot: at most one queued behind a running one; two runs
  // at once would still be safe (null check and tags_digest guard in the update)
  'files.backfillDigest': 'stately',
  // enqueued at every boot like files.backfillDigest: one queued behind a running one
  'cluster.backfillLoose': 'stately',
  // the books app's grouping (in development): one queued per folder behind the running one, as cluster.dir
  'books.group': 'stately',
  'artists.resolve': 'stately',
  'artists.enrich': 'stately',
  'artists.refresh': 'stately',
  'artist.refresh': 'stately',
  'tags.preview': 'stately',
  'tags.apply': 'stately',
  // one queued per library and action behind the running one; every run does all that waits
  'files.trash': 'stately',
  // one queued per split and action (singletonKey files.split:<id>:<action>)
  'files.split': 'stately',
  'files.upgrade': 'stately',
  // one queued per move and step (singletonKey files.move:<id>:<action>)
  'files.move': 'stately',
  'tags.revert': 'stately',
  'facets.refresh': 'stately',
  'fingerprint.album': 'stately',
  'fingerprint.sweep': 'stately',
  'acoustid.lookup': 'stately',
  'tracks.link': 'stately',
  // one queued per link (singletonKey connections.pull:<link id>) behind the running one
  'connections.pull': 'stately',
  // one queued per album or artist (singletonKey listen:rg:<id> / listen:artist:<id>)
  'listenLinks.resolve': 'stately',
  // one queued per artist (singletonKey similar:<artist id>) behind the running one
  'similarArtists.fetch': 'stately',
  // one queued per track (singletonKey dj:<track> from the sweep, dj:now:<track> from the player) and one sweep (dj:sweep)
  'dj.analyze': 'stately',
  // one poll queued behind the running one (singletonKey lidarr.poll); one Get all missing per artist
  'lidarr.poll': 'stately',
  // one scan of the pool queued behind the running one (singletonKey pool.scan, or pool.scan:<library>)
  'pool.scan': 'stately',
  'lidarr.get': 'stately',
  // enqueued at every boot and by itself pass after pass: one queued behind a running one
  'evidence.backfill': 'stately',
  // one run per batch (singletonKey on the batch id) queued behind a running one
  'decider.accept': 'stately',
  // one run per library (singletonKey decider.run:<library id>) queued behind a running one
  'decider.run': 'stately',
  // one training per library (singletonKey decider.train:<library id>) queued behind a running one
  'decider.train': 'stately',
};

/**
 * pg-boss expires an active job after 15 minutes by default and retries it
 * twice — a walk of the NFS root takes longer, so the first run was retried
 * while still walking and three scans ran at once (2026-09-08). Scans get a
 * day and no retries; scan.sweep re-enqueues on its own schedule.
 */
export const LONG_JOB_QUEUES: Record<string, { expireInSeconds: number; retryLimit: number }> = {
  'scan.root': { expireInSeconds: 23 * 3600, retryLimit: 0 }, // pg-boss asserts < 24 h
  'scan.dir': { expireInSeconds: 6 * 3600, retryLimit: 0 },
  // checks every cover without a thumbnail (27,000 after a restore); the
  // next scheduled or requested sweep picks up whatever a failed one left
  'art.thumbSweep': { expireInSeconds: 2 * 3600, retryLimit: 0 },
  // a first run over a whole library; the next boot resumes where it stopped
  'files.backfillDigest': { expireInSeconds: 3600, retryLimit: 0 },
  // bounded per run; the next boot sends what is left
  'cluster.backfillLoose': { expireInSeconds: 3600, retryLimit: 0 },
  // re-encodes a whole album (a 2 GB 24/192 image takes minutes); a failed
  // split leaves nothing behind and the owner presses Split again
  'files.split': { expireInSeconds: 3 * 3600, retryLimit: 0 },
  // a move that stops has put back what it did; the owner presses Move again
  'files.move': { expireInSeconds: 3600, retryLimit: 0 },
  // 200 albums per pass, each pass sending the next; the next boot starts over
  'evidence.backfill': { expireInSeconds: 3600, retryLimit: 0 },
  // a batch of thousands of albums, one transaction each; a retry resumes at the first pending item
  'decider.accept': { expireInSeconds: DECIDER_ACCEPT_EXPIRE_SECONDS, retryLimit: 2 },
  // a run over a whole library, paid call by call; a retry skips the calls it already paid for
  'decider.run': { expireInSeconds: DECIDER_RUN_EXPIRE_SECONDS, retryLimit: 3 },
};

/**
 * Every queue retries with a delay that grows: pg-boss's default is an
 * immediate retry, so during the 2026-10-08 outage collection.sync spent its
 * three tries in four seconds. 1 min, 2 min, 4 min … capped at an hour gives
 * a network blip or a provider restart time to pass. Applied to existing
 * queues on every boot (createQueue does not touch a queue that exists).
 * A job sent with its own retry options (enrich.sweep, identify) keeps them.
 */
export const QUEUE_RETRY_DEFAULTS = { retryDelay: 60, retryBackoff: true, retryDelayMax: 3600 } as const;

/** Creates every queue (pg-boss v10+ needs it before work()) and (re)applies its policy and limits. */
export async function prepareWorkerQueues(boss: PgBoss, sql: postgres.Sql, extra: readonly string[] = []): Promise<void> {
  // Queues must exist before work() in pg-boss v10+.
  // One list for the worker and the worker check (@tagave/core).
  const queues = [...WORKER_QUEUES, ...extra];
  for (const q of queues) {
    const opts = { ...(QUEUE_POLICIES[q] ? { policy: QUEUE_POLICIES[q] } : {}), ...QUEUE_RETRY_DEFAULTS, ...(LONG_JOB_QUEUES[q] ?? {}) };
    await boss.createQueue(q, opts);
    await boss.updateQueue(q, { ...QUEUE_RETRY_DEFAULTS, ...(LONG_JOB_QUEUES[q] ?? {}) });
  }
  // The player module's scans: this worker only sends to it after a tag
  // write; the app works it (it holds the player's credentials).
  await boss.createQueue('player.scan', { policy: 'stately', ...QUEUE_RETRY_DEFAULTS });
  // pg-boss ≥10 honours singletonKey only under a non-standard queue policy,
  // and updateQueue() cannot change the policy of an existing queue — so the
  // policies are (re)applied here on every boot for queues created before.
  for (const [name, policy] of Object.entries(QUEUE_POLICIES)) {
    await sql`update pgboss.queue set policy = ${policy} where name = ${name} and policy <> ${policy}`;
  }
  for (const [name, o] of Object.entries(LONG_JOB_QUEUES)) {
    await sql`update pgboss.queue set expire_seconds = ${o.expireInSeconds}, retry_limit = ${o.retryLimit}
               where name = ${name} and (expire_seconds <> ${o.expireInSeconds} or retry_limit <> ${o.retryLimit})`;
  }
}

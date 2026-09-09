import PgBoss from 'pg-boss';
import pino from 'pino';
import { makeDb } from '@liner/db';
import { readBuildInfo } from '@liner/core';
import { setCooldownObserver } from './lib/pacer.js';
import { startWatchdog, tracked, withTimeout, JobTimeoutError } from './lib/watchdog.js';
import type { WorkerContext } from './lib/context.js';
import { scanRootJob, type ScanRootJobData } from './jobs/scanRoot.js';
import { scanDirJob, type ScanDirJobData } from './jobs/scanDir.js';
import { scanSweepJob, type ScanSweepJobData } from './jobs/scanSweep.js';
import { rootsValidateJob, type RootsValidateJobData } from './jobs/rootsValidate.js';
import { scanParseJob, type ScanParseJobData } from './jobs/scanParse.js';
import { clusterDirJob, type ClusterDirJobData } from './jobs/clusterDir.js';
import { clusterRepairDiscsJob, type ClusterRepairDiscsJobData } from './jobs/clusterRepairDiscs.js';
import { identifyAlbumJob, type IdentifyAlbumJobData } from './jobs/identifyAlbum.js';
import { identifySweepJob, type IdentifySweepJobData } from './jobs/identifySweep.js';
import { enrichReleaseJob, type EnrichReleaseJobData } from './jobs/enrichRelease.js';
import { enrichSweepJob, type EnrichSweepJobData } from './jobs/enrichSweep.js';
import { editionsFetchJob, type EditionsFetchJobData } from './jobs/editionsFetch.js';
import { artFetchJob, artSweepJob, type ArtFetchJobData, type ArtSweepJobData } from './jobs/artFetch.js';
import { gapsRecomputeJob, type GapsRecomputeJobData } from './jobs/gapsRecompute.js';
import { facetsRefreshJob, type FacetsRefreshJobData } from './jobs/facetsRefresh.js';
import { fingerprintAlbumJob, type FingerprintAlbumJobData } from './jobs/fingerprintAlbum.js';
import { fingerprintSweepJob, type FingerprintSweepJobData } from './jobs/fingerprintSweep.js';
import { acoustidLookupJob, type AcoustidLookupJobData } from './jobs/acoustidLookup.js';
import { queueAutoAcceptJob, type QueueAutoAcceptJobData } from './jobs/queueAutoAccept.js';
import { collectionSyncJob, collectionPushJob, collectionRemoveJob, type CollectionSyncJobData, type CollectionPushJobData, type CollectionRemoveJobData } from './jobs/collectionSync.js';
import { reviewsFetchJob, type ReviewsFetchJobData } from './jobs/reviewsFetch.js';
import { artistsResolveJob, type ArtistsResolveJobData } from './jobs/artistsResolve.js';
import { artistsEnrichJob, type ArtistsEnrichJobData } from './jobs/artistsEnrich.js';
import { artistsRefreshSweepJob, type ArtistsRefreshSweepJobData } from './jobs/artistsRefreshSweep.js';
import { tagsPreviewJob } from './jobs/tagsPreview.js';
import { tagsApplyJob, type TagsApplyJobData } from './jobs/tagsApply.js';
import { tagsRevertJob, type TagsRevertJobData } from './jobs/tagsRevert.js';
import { artistRefreshJob, type ArtistRefreshJobData } from './jobs/artistRefresh.js';
import { tracksLinkJob, type TracksLinkJobData } from './jobs/tracksLink.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  logger.error('DATABASE_URL environment variable not set');
  process.exit(1);
}

/**
 * Queue policies that make singletonKey mean something. 'stately' keeps one
 * job per key per state (one queued behind one active, so a re-request during
 * a run still runs afterwards); 'exclusive' keeps one per key across both
 * (reviews.fetch is enqueued by a polling album page). Not listed on purpose:
 * cluster.dir — scan.parse re-sends a directory as parse batches land and
 * every send must run; collection.* belong to the collection sync session.
 */
const QUEUE_POLICIES: Record<string, 'stately' | 'exclusive'> = {
  'reviews.fetch': 'exclusive',
  'editions.fetch': 'stately',
  'enrich.release': 'stately',
  'enrich.sweep': 'stately',
  'art.fetch': 'stately',
  'identify.album': 'stately',
  'identify.acoustid': 'stately',
  'roots.validate': 'stately',
  'scan.root': 'stately',
  'scan.dir': 'stately',
  'scan.sweep': 'stately',
  // Sibling disc folders resolve to one scope; two jobs on it must not interleave.
  'cluster.dir': 'stately',
  'artists.resolve': 'stately',
  'artists.enrich': 'stately',
  'artists.refresh': 'stately',
  'artist.refresh': 'stately',
  'tags.preview': 'stately',
  'tags.apply': 'stately',
  'tags.revert': 'stately',
  'facets.refresh': 'stately',
  'fingerprint.album': 'stately',
  'fingerprint.sweep': 'stately',
  'acoustid.lookup': 'stately',
  'tracks.link': 'stately',
};

const M1_PLACEHOLDER_QUEUES: string[] = [];

/**
 * pg-boss expires an active job after 15 minutes by default and retries it
 * twice — a walk of the NFS root takes longer, so the first run was retried
 * while still walking and three scans ran at once (2026-09-08). Scans get a
 * day and no retries; scan.sweep re-enqueues on its own schedule.
 */
const LONG_JOB_QUEUES: Record<string, { expireInSeconds: number; retryLimit: number }> = {
  'scan.root': { expireInSeconds: 23 * 3600, retryLimit: 0 }, // pg-boss asserts < 24 h
  'scan.dir': { expireInSeconds: 6 * 3600, retryLimit: 0 },
};

/** Provider waits are paced at ~1 req/s and capped at 3 lookups; 5 min is far past any honest run. */
const IDENTIFY_JOB_TIMEOUT_MS = 5 * 60_000;

async function main() {
  const { db, client } = await makeDb(databaseUrl as string);
  const boss = new PgBoss(databaseUrl as string);
  boss.on('error', (error: Error) => logger.error({ err: error }, 'pg-boss error'));
  await boss.start();

  const ctx: WorkerContext = { db, sql: client, boss, logger };
  setCooldownObserver((provider, ms, attempt, reason) => logger.warn({ provider, ms, attempt, reason: reason.slice(0, 200) }, 'provider cooldown opened'));
  const workerId = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const build = readBuildInfo();
  logger.info({ workerId, version: build.version, sha: build.sha, buildSource: build.source }, 'worker connected');
  const watchdog = startWatchdog(logger);

  // Queues must exist before work() in pg-boss v10+.
  const queues = ['scan.root', 'scan.dir', 'scan.sweep', 'roots.validate', 'scan.parse', 'cluster.dir', 'cluster.repairDiscs', 'identify.album', 'identify.acoustid', 'identify.sweep', 'enrich.release', 'enrich.sweep', 'editions.fetch', 'art.fetch', 'art.sweep', 'gaps.recompute', 'queue.autoaccept', 'collection.sync', 'collection.push', 'collection.remove', 'reviews.fetch', 'artists.resolve', 'artists.enrich', 'artists.refresh', 'artist.refresh', 'tags.preview', 'tags.apply', 'tags.revert', 'facets.refresh', 'fingerprint.album', 'fingerprint.sweep', 'acoustid.lookup', 'tracks.link', ...M1_PLACEHOLDER_QUEUES];
  for (const q of queues) {
    const opts = { ...(QUEUE_POLICIES[q] ? { policy: QUEUE_POLICIES[q] } : {}), ...(LONG_JOB_QUEUES[q] ?? {}) };
    await boss.createQueue(q, Object.keys(opts).length ? opts : undefined);
  }
  // pg-boss ≥10 honours singletonKey only under a non-standard queue policy,
  // and updateQueue() cannot change the policy of an existing queue — so the
  // policies are (re)applied here on every boot for queues created before.
  for (const [name, policy] of Object.entries(QUEUE_POLICIES)) {
    await client`update pgboss.queue set policy = ${policy} where name = ${name} and policy <> ${policy}`;
  }
  for (const [name, o] of Object.entries(LONG_JOB_QUEUES)) {
    await client`update pgboss.queue set expire_seconds = ${o.expireInSeconds}, retry_limit = ${o.retryLimit}
                 where name = ${name} and (expire_seconds <> ${o.expireInSeconds} or retry_limit <> ${o.retryLimit})`;
  }

  // LINER_QUEUES=identify.album,identify.sweep,artists.resolve,artists.enrich
  // restricts which queues this process works — lets an identify-only worker
  // run beside the file worker. Default: all queues. For identify worker, add
  // artists.resolve,artists.enrich to include artist enrichment jobs.
  const only = process.env.LINER_QUEUES ? new Set(process.env.LINER_QUEUES.split(',').map((q) => q.trim())) : null;
  const wants = (q: string) => !only || only.has(q);

  if (wants('scan.root')) {
    await boss.work<ScanRootJobData>('scan.root', { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) {
        logger.info({ jobId: job.id, data: job.data }, 'scan.root start');
        await scanRootJob(ctx, job.data);
      }
    });

    await boss.work<RootsValidateJobData>('roots.validate', { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) {
        logger.info({ jobId: job.id, data: job.data }, 'roots.validate start');
        await rootsValidateJob(ctx, job.data);
      }
    });

    // Boot enqueue validation of all roots (spec LIB-1)
    await boss.send('roots.validate', {}, { singletonKey: 'roots.validate:all' });
    // Every 10 minutes validate all roots (spec LIB-1)
    await boss.schedule('roots.validate', '*/10 * * * *', {}, {});
  }

  // One folder at a time (the album page's "Rescan this folder"); shares the
  // walker with scan.root, so it lives on the same worker.
  if (wants('scan.dir')) await boss.work<ScanDirJobData>('scan.dir', { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      logger.info({ jobId: job.id, data: job.data }, 'scan.dir start');
      await scanDirJob(ctx, job.data);
    }
  });

  // Per-root poll (spec LIB-4): quick scans at each root's interval, a full
  // scan weekly; checked every 10 minutes.
  if (wants('scan.sweep')) {
    await boss.work<ScanSweepJobData>('scan.sweep', { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) await scanSweepJob(ctx, job.data);
    });
    await boss.schedule('scan.sweep', '*/10 * * * *', {}, { singletonKey: 'scan.sweep' });
  }

  if (wants('scan.parse')) await boss.work<ScanParseJobData>(
    'scan.parse',
    { batchSize: 4, pollingIntervalSeconds: 1 },
    async (jobs) => {
      await Promise.all(jobs.map((job) => scanParseJob(ctx, job.data)));
    },
  );

  if (wants('cluster.dir')) await boss.work<ClusterDirJobData>('cluster.dir', { batchSize: 6 }, async (jobs) => {
    await Promise.all(jobs.map((job) => clusterDirJob(ctx, job.data)));
  });

  // Run by hand after the disc-aware clustering ships: sweeps the library for
  // the multi-disc layouts, re-clusters them and re-identifies what changed.
  // The handler's return value becomes the job's output, so the counts a
  // dryRun pass reports are readable from pgboss.job.output.
  if (wants('cluster.repairDiscs')) await boss.work<ClusterRepairDiscsJobData>('cluster.repairDiscs', { batchSize: 1 }, async (jobs) => {
    const results = [];
    for (const job of jobs) {
      logger.info({ jobId: job.id, data: job.data }, 'cluster.repairDiscs start');
      results.push(await clusterRepairDiscsJob(ctx, job.data));
    }
    return results.length === 1 ? results[0] : results;
  });

  // Three albums in flight: provider calls still go one at a time through
  // the shared pacer, but DB work, Discogs and scoring overlap instead of
  // leaving MusicBrainz idle (measured 2/min at batchSize 1, p50 12 s/job).
  // Each job is bounded on its own (XO-318): one that hangs is failed alone
  // through boss.fail() and pg-boss retries it later; the batch completes
  // the rest as usual.
  // XO-379: independent pollers, one job each (a single work() with batchSize
  // N fetches the next batch only after the whole batch returns). Two queues
  // run the same job: identify.album (sweep/manual/triage; the Discogs-only
  // first pass takes ~2 s) and identify.acoustid (fingerprint-backed, always
  // MusicBrainz-bound: ~1–3 min each while MB is busy). Separate pollers keep
  // the MB-bound jobs from occupying every slot; provider calls still
  // serialise through the shared pacers, so this adds no traffic.
  const identifyHandler = (queue: 'identify.album' | 'identify.acoustid') => async (jobs: Array<{ id: string; data: IdentifyAlbumJobData }>) => {
    const results = await Promise.allSettled(jobs.map((job) =>
      tracked(queue, job.id, job.data.localAlbumId, () =>
        withTimeout(IDENTIFY_JOB_TIMEOUT_MS, `${queue} ${job.data.localAlbumId}`, () => identifyAlbumJob(ctx, job.data)))));
    for (const [i, r] of results.entries()) {
      if (r.status !== 'rejected') continue;
      const job = jobs[i]!;
      const err = r.reason as Error;
      logger.error({ queue, jobId: job.id, localAlbumId: job.data.localAlbumId, err: err.message, timedOut: err instanceof JobTimeoutError }, 'identify job failed');
      await boss.fail(queue, job.id, { message: err.message });
    }
  };
  const IDENTIFY_WORKERS = Number(process.env['IDENTIFY_CONCURRENCY'] ?? 5);
  const ACOUSTID_IDENTIFY_WORKERS = Number(process.env['ACOUSTID_IDENTIFY_CONCURRENCY'] ?? 3);
  if (wants('identify.album')) for (let w = 0; w < IDENTIFY_WORKERS; w++) {
    await boss.work<IdentifyAlbumJobData>('identify.album', { batchSize: 1, pollingIntervalSeconds: 1 }, identifyHandler('identify.album'));
  }
  if (wants('identify.acoustid')) for (let w = 0; w < ACOUSTID_IDENTIFY_WORKERS; w++) {
    await boss.work<IdentifyAlbumJobData>('identify.acoustid', { batchSize: 1, pollingIntervalSeconds: 1 }, identifyHandler('identify.acoustid'));
  }

  if (wants('identify.sweep')) {
    await boss.work<IdentifySweepJobData>('identify.sweep', { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) await identifySweepJob(ctx, job.data);
    });
    // Keep the sweep fed and its status row fresh (XO-309): every 5 minutes
    // top up the identify queue from pending albums and refresh coverage/ETA.
    await boss.schedule('identify.sweep', '*/5 * * * *', { topUp: true }, {});
  }

  if (wants('enrich.release')) {
    await boss.work<EnrichReleaseJobData>('enrich.release', { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) await enrichReleaseJob(ctx, job.data);
    });

    await boss.work<EditionsFetchJobData>('editions.fetch', { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) await editionsFetchJob(ctx, job.data);
    });

    await boss.work<CollectionSyncJobData>('collection.sync', { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) await collectionSyncJob(ctx, job.data);
    });

    await boss.work<CollectionPushJobData>('collection.push', { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) await collectionPushJob(ctx, job.data);
    });

    await boss.work<CollectionRemoveJobData>('collection.remove', { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) await collectionRemoveJob(ctx, job.data);
    });

    // Schedule daily collection.sync at 04:15 for default library (spec COL-1)
    await boss.schedule('collection.sync', '15 4 * * *',
      { libraryId: process.env.LINER_LIBRARY_ID ?? '01a05c38-c7d3-7d58-b32a-0f0ecc428e64' }, {});
  }

  if (wants('enrich.sweep')) {
    // XO-379 pass 2: the MusicBrainz bridge runs at night, hourly 02:00–06:00,
    // Discogs-only releases first (url-rels, then barcode / catalogue number).
    // 400 per run ≈ 2,000 releases a night at MB's pace.
    await boss.schedule('enrich.sweep', '0 2-6 * * *', { limit: 400 }, { singletonKey: 'enrich.sweep' });
  }
  if (wants('enrich.sweep')) await boss.work<EnrichSweepJobData>('enrich.sweep', { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) await enrichSweepJob(ctx, job.data);
  });

  if (wants('art.fetch')) await boss.work<ArtFetchJobData>('art.fetch', { batchSize: 4 }, async (jobs) => {
    await Promise.all(jobs.map((job) => artFetchJob(ctx, job.data)));
  });

  if (wants('art.sweep')) await boss.work<ArtSweepJobData>('art.sweep', { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) await artSweepJob(ctx, job.data);
  });

  if (wants('queue.autoaccept')) await boss.work<QueueAutoAcceptJobData>('queue.autoaccept', { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) await queueAutoAcceptJob(ctx, job.data);
  });

  // Per opened album only — never swept (spec REV-1); shares the MB pacer.
  if (wants('reviews.fetch')) await boss.work<ReviewsFetchJobData>('reviews.fetch', { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) await reviewsFetchJob(ctx, job.data);
  });

  if (wants('artists.resolve')) {
    await boss.work<ArtistsResolveJobData>('artists.resolve', { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) await artistsResolveJob(ctx, job.data);
    });
    // Schedule every 10 minutes, ~2 req/min (20 RGs per run at 30s TTL each)
    await boss.schedule('artists.resolve', '*/10 * * * *', {}, { singletonKey: 'artists.resolve' });
  }

  if (wants('artists.enrich')) {
    await boss.work<ArtistsEnrichJobData>('artists.enrich', { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) await artistsEnrichJob(ctx, job.data);
    });
  }

  if (wants('artists.refresh')) {
    await boss.work<ArtistsRefreshSweepJobData>('artists.refresh', { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) await artistsRefreshSweepJob(ctx, job.data);
    });
    // Weekly sweep every Monday at 05:00 (spec: weekly, gated by discographyRefreshEnabled)
    await boss.schedule('artists.refresh', '0 5 * * 1', {}, { singletonKey: 'artists.refresh' });
  }

  if (wants('artist.refresh')) {
    await boss.work<ArtistRefreshJobData>('artist.refresh', { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) await artistRefreshJob(ctx, job.data);
    });
  }

  if (wants('tracks.link')) {
    await boss.work<TracksLinkJobData>('tracks.link', { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) {
        logger.info({ jobId: job.id, data: job.data }, 'tracks.link start');
        await tracksLinkJob(ctx, job.data);
      }
    });
    // Sweep every 5 minutes to link unlinked albums
    await boss.schedule('tracks.link', '*/5 * * * *', { sweep: true }, { singletonKey: 'tracks.link:sweep' });
  }

  // IDN-5 (XO-372): fingerprints on the file worker (needs the mount and fpcalc),
  // AcoustID lookups on the identify worker (shares the provider budget).
  if (wants('fingerprint.album')) {
    await boss.work<FingerprintAlbumJobData>('fingerprint.album', { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) await fingerprintAlbumJob(ctx, job.data);
    });
  }
  if (wants('fingerprint.sweep')) {
    await boss.work<FingerprintSweepJobData>('fingerprint.sweep', { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) await fingerprintSweepJob(ctx, job.data);
    });
    // a no-op unless a library opted in (settings.fingerprintingEnabled) and has an AcoustID key
    // 30 albums every 10 min ≈ 180/h: about what identify.album clears under
    // MusicBrainz's "server busy" ceiling, so AcoustID candidates (priority 50)
    // neither starve nor pile up ahead of it
    await boss.schedule('fingerprint.sweep', '*/10 * * * *', {}, { singletonKey: 'fingerprint.sweep' });
  }
  if (wants('acoustid.lookup')) {
    await boss.work<AcoustidLookupJobData>('acoustid.lookup', { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) await acoustidLookupJob(ctx, job.data);
    });
  }

  if (wants('facets.refresh')) {
    await boss.work<FacetsRefreshJobData>('facets.refresh', { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) await facetsRefreshJob(ctx, job.data);
    });
    // Every minute; a no-op unless albums, gaps or the collection changed since
    // the last build (XO-363). The boot send fills an empty table right away.
    await boss.schedule('facets.refresh', '* * * * *', {}, { singletonKey: 'facets.refresh' });
    await boss.send('facets.refresh', { force: true }, { singletonKey: 'facets.refresh:boot' });
  }

  if (wants('gaps.recompute')) {
    await boss.work<GapsRecomputeJobData>('gaps.recompute', { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) await gapsRecomputeJob(ctx, job.data);
    });
    // nightly at 03:15 (spec: nightly + after identification batches)
    await boss.schedule('gaps.recompute', '15 3 * * *',
      { libraryId: process.env.LINER_LIBRARY_ID ?? '01a05c38-c7d3-7d58-b32a-0f0ecc428e64' }, {});
  }

  if (wants('tags.preview')) {
    await boss.work('tags.preview', { batchSize: 1 }, async (jobs: any[]) => {
      for (const job of jobs) {
        const planId = (job.data as { planId: string }).planId;
        logger.info({ jobId: job.id, planId }, 'tags.preview start');
        await tagsPreviewJob(ctx, planId);
      }
    });
  }

  if (wants('tags.apply')) {
    await boss.work<TagsApplyJobData>('tags.apply', { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) {
        logger.info({ jobId: job.id, planId: job.data.planId }, 'tags.apply start');
        await tagsApplyJob(ctx, job.data);
      }
    });
  }

  if (wants('tags.revert')) {
    await boss.work<TagsRevertJobData>('tags.revert', { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) {
        logger.info({ jobId: job.id, planId: job.data.planId }, 'tags.revert start');
        await tagsRevertJob(ctx, job.data);
      }
    });
  }

  for (const q of M1_PLACEHOLDER_QUEUES) {
    await boss.work(q, async (jobs) => {
      for (const job of jobs) logger.info({ jobId: job.id, queue: q }, 'queue not implemented yet (M1+)');
    });
  }
  logger.info({ queues: queues.length }, 'job handlers registered');

  // Heartbeat: the API's /health reads the freshest worker.heartbeat row.
  // It carries the build identity and the served queues so Settings › Updates
  // can show a worker lagging the app (XO-313), plus the worst event-loop lag
  // of the last interval (XO-318).
  const servedQueues = only ? [...only] : ['*'];
  const heartbeat = setInterval(() => {
    void (async () => {
      try {
        const loopLagMs = watchdog.maxLagMs();
        if (loopLagMs > 5_000) logger.warn({ loopLagMs }, 'event loop lag');
        await ctx.sql`
          insert into job_runs (id, library_id, type, state, progress, created_at)
          select gen_random_uuid(), l.id, 'worker.heartbeat', 'completed',
                 ${JSON.stringify({
                   workerId, at: new Date().toISOString(),
                   version: build.version, sha: build.sha, builtAt: build.builtAt,
                   queues: servedQueues, host: process.env['HOSTNAME'] ?? null, loopLagMs,
                 })}::jsonb, now()
          from libraries l limit 1
          on conflict do nothing`;
        await ctx.sql`
          delete from job_runs
          where type = 'worker.heartbeat'
            and created_at < now() - interval '10 minutes'`;
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'heartbeat failed');
      }
    })();
  }, 30_000);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down...');
    clearInterval(heartbeat);
    await watchdog.stop().catch(() => undefined);
    try {
      await boss.stop({ graceful: true, timeout: 30_000 });
    } catch (err) {
      logger.error({ err }, 'error stopping pg-boss');
    }
    try {
      await client.end({ timeout: 5 });
    } catch {
      /* closing */
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  logger.info({ workerId }, 'worker ready');
}

main().catch((err) => {
  logger.error({ err }, 'worker failed to start');
  process.exit(1);
});

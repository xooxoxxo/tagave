import PgBoss from 'pg-boss';
import pino from 'pino';
import { makeDb } from '@liner/db';
import type { WorkerContext } from './lib/context.js';
import { scanRootJob, type ScanRootJobData } from './jobs/scanRoot.js';
import { rootsValidateJob, type RootsValidateJobData } from './jobs/rootsValidate.js';
import { scanParseJob, type ScanParseJobData } from './jobs/scanParse.js';
import { clusterDirJob, type ClusterDirJobData } from './jobs/clusterDir.js';
import { identifyAlbumJob, type IdentifyAlbumJobData } from './jobs/identifyAlbum.js';
import { identifySweepJob, type IdentifySweepJobData } from './jobs/identifySweep.js';
import { enrichReleaseJob, type EnrichReleaseJobData } from './jobs/enrichRelease.js';
import { enrichSweepJob, type EnrichSweepJobData } from './jobs/enrichSweep.js';
import { editionsFetchJob, type EditionsFetchJobData } from './jobs/editionsFetch.js';
import { artFetchJob, artSweepJob, type ArtFetchJobData, type ArtSweepJobData } from './jobs/artFetch.js';
import { gapsRecomputeJob, type GapsRecomputeJobData } from './jobs/gapsRecompute.js';
import { queueAutoAcceptJob, type QueueAutoAcceptJobData } from './jobs/queueAutoAccept.js';
import { collectionSyncJob, collectionPushJob, collectionRemoveJob, type CollectionSyncJobData, type CollectionPushJobData, type CollectionRemoveJobData } from './jobs/collectionSync.js';
import { reviewsFetchJob, type ReviewsFetchJobData } from './jobs/reviewsFetch.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  logger.error('DATABASE_URL environment variable not set');
  process.exit(1);
}

const M1_PLACEHOLDER_QUEUES = [
  'enrich.artist',
  'tags.preview', 'tags.apply', 'tags.revert',
  'artist.refresh',
];

async function main() {
  const { db, client } = await makeDb(databaseUrl as string);
  const boss = new PgBoss(databaseUrl as string);
  boss.on('error', (error: Error) => logger.error({ err: error }, 'pg-boss error'));
  await boss.start();

  const ctx: WorkerContext = { db, sql: client, boss, logger };
  const workerId = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  logger.info({ workerId }, 'worker connected');

  // Queues must exist before work() in pg-boss v10+.
  const queues = ['scan.root', 'roots.validate', 'scan.parse', 'cluster.dir', 'identify.album', 'identify.sweep', 'enrich.release', 'enrich.sweep', 'editions.fetch', 'art.fetch', 'art.sweep', 'gaps.recompute', 'queue.autoaccept', 'collection.sync', 'collection.push', 'collection.remove', 'reviews.fetch', ...M1_PLACEHOLDER_QUEUES];
  for (const q of queues) await boss.createQueue(q);
  // singletonKey dedupes only under a non-standard queue policy (pg-boss ≥10)
  // and updateQueue() cannot change it; the album page enqueues reviews.fetch
  // on every poll, so keep one job per release group in created/active state.
  await client`update pgboss.queue set policy = 'exclusive' where name = 'reviews.fetch' and policy <> 'exclusive'`;

  // LINER_QUEUES=identify.album,identify.sweep restricts which queues this
  // process works — lets an identify-only worker run beside the file worker.
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

  if (wants('identify.album')) await boss.work<IdentifyAlbumJobData>('identify.album', { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) await identifyAlbumJob(ctx, job.data);
  });

  if (wants('identify.sweep')) await boss.work<IdentifySweepJobData>('identify.sweep', { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) await identifySweepJob(ctx, job.data);
  });

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

  if (wants('gaps.recompute')) {
    await boss.work<GapsRecomputeJobData>('gaps.recompute', { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) await gapsRecomputeJob(ctx, job.data);
    });
    // nightly at 03:15 (spec: nightly + after identification batches)
    await boss.schedule('gaps.recompute', '15 3 * * *',
      { libraryId: process.env.LINER_LIBRARY_ID ?? '01a05c38-c7d3-7d58-b32a-0f0ecc428e64' }, {});
  }

  for (const q of M1_PLACEHOLDER_QUEUES) {
    await boss.work(q, async (jobs) => {
      for (const job of jobs) logger.info({ jobId: job.id, queue: q }, 'queue not implemented yet (M1+)');
    });
  }
  logger.info({ queues: queues.length }, 'job handlers registered');

  // Heartbeat: the API's /health reads the freshest worker.heartbeat row.
  const heartbeat = setInterval(() => {
    void (async () => {
      try {
        await ctx.sql`
          insert into job_runs (id, library_id, type, state, progress, created_at)
          select gen_random_uuid(), l.id, 'worker.heartbeat', 'completed',
                 ${JSON.stringify({ workerId, at: new Date().toISOString() })}::jsonb, now()
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

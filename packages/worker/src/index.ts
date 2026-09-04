import PgBoss from 'pg-boss';
import pino from 'pino';
import { makeDb } from '@liner/db';
import type { WorkerContext } from './lib/context.js';
import { scanRootJob, type ScanRootJobData } from './jobs/scanRoot.js';
import { scanParseJob, type ScanParseJobData } from './jobs/scanParse.js';
import { clusterDirJob, type ClusterDirJobData } from './jobs/clusterDir.js';
import { identifyAlbumJob, type IdentifyAlbumJobData } from './jobs/identifyAlbum.js';
import { identifySweepJob, type IdentifySweepJobData } from './jobs/identifySweep.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  logger.error('DATABASE_URL environment variable not set');
  process.exit(1);
}

const M1_PLACEHOLDER_QUEUES = [
  'enrich.release', 'enrich.artist', 'art.fetch',
  'tags.preview', 'tags.apply', 'tags.revert',
  'gaps.recompute', 'artist.refresh', 'reviews.fetch', 'collection.sync',
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
  const queues = ['scan.root', 'scan.parse', 'cluster.dir', 'identify.album', 'identify.sweep', ...M1_PLACEHOLDER_QUEUES];
  for (const q of queues) await boss.createQueue(q);

  // LINER_QUEUES=identify.album,identify.sweep restricts which queues this
  // process works — lets an identify-only worker run beside the file worker.
  const only = process.env.LINER_QUEUES ? new Set(process.env.LINER_QUEUES.split(',').map((q) => q.trim())) : null;
  const wants = (q: string) => !only || only.has(q);

  if (wants('scan.root')) await boss.work<ScanRootJobData>('scan.root', { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      logger.info({ jobId: job.id, data: job.data }, 'scan.root start');
      await scanRootJob(ctx, job.data);
    }
  });

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

import PgBoss from 'pg-boss';
import postgres from 'postgres';
import pino from 'pino';
import type { Logger } from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
});

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  logger.error('DATABASE_URL environment variable not set');
  process.exit(1);
}

let worker: PgBoss | null = null;
let db: any = null;
let workerId: string = '';

/**
 * Initialize the worker with pg-boss and database connection.
 * Registers all job handlers.
 */
async function initializeWorker() {
  const sql = postgres(databaseUrl as string);

  // db initialization (simplified - full implementation in M0)
  db = sql;

  // pg-boss connects directly to postgres
  worker = new PgBoss(databaseUrl as string);

  workerId = `worker-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  // Handle worker events
  worker.on('error', (error: Error) => {
    logger.error({ err: error }, 'pg-boss error');
  });

  worker.on('stopped', () => {
    logger.info('Worker stopped');
  });

  // Connect and start
  await worker.start();
  logger.info({ workerId }, 'Worker connected to pg-boss');

  // Register job handlers
  // Scan jobs (M0)
  await worker.work('scan.root', async (job: any) => {
    logger.info({ jobId: job.id }, 'Processing scan.root job');
  });

  await worker.work('scan.parse', async (job: any) => {
    logger.info({ jobId: job.id }, 'Processing scan.parse job');
  });

  await worker.work('cluster.dir', async (job: any) => {
    logger.info({ jobId: job.id }, 'Processing cluster.dir job');
  });

  await worker.work('job.progress', async (job: any) => {
    logger.info({ jobId: job.id }, 'Processing job.progress job');
  });

  // Placeholder handlers for M1+ (to be implemented)
  const m1JobTypes = [
    'identify.album',
    'enrich.release',
    'enrich.artist',
    'art.fetch',
    'tags.preview',
    'tags.apply',
    'tags.revert',
    'gaps.recompute',
    'artist.refresh',
    'reviews.fetch',
    'collection.sync',
  ];

  for (const jobType of m1JobTypes) {
    await worker.work(jobType, async (job: any) => {
      logger.info({ jobId: job.id, jobType }, `${jobType} not yet implemented`);
    });
  }

  logger.info('All job handlers registered');
}

/**
 * Start the worker heartbeat: log that worker is alive.
 */
async function startHeartbeat() {
  const heartbeatInterval = setInterval(async () => {
    try {
      logger.debug({ workerId }, 'Worker heartbeat');
    } catch (err) {
      logger.error({ err }, 'Heartbeat update failed');
    }
  }, 30000); // Every 30 seconds

  return heartbeatInterval;
}

/**
 * Graceful shutdown: stop accepting new jobs, finish in-flight ones,
 * disconnect pg-boss and database.
 */
async function shutdown() {
  logger.info('Shutting down worker...');

  if (worker) {
    try {
      await worker.stop({ graceful: true, timeout: 30000 });
      logger.info('Worker stopped gracefully');
    } catch (err) {
      logger.error({ err }, 'Error stopping worker');
    }
  }

  process.exit(0);
}

// Handle signals
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Main startup
async function main() {
  try {
    await initializeWorker();
    await startHeartbeat();

    logger.info({ workerId }, 'Worker started and ready to process jobs');

    // Keep the process alive
    await new Promise(() => {
      // This never resolves; the process is kept alive by signal handlers
    });
  } catch (err) {
    logger.error({ err }, 'Failed to start worker');
    process.exit(1);
  }
}

main().catch((err) => {
  logger.error({ err }, 'Unexpected error in worker main');
  process.exit(1);
});

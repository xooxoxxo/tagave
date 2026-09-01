import type { Logger } from 'pino';
import type PgBoss from 'pg-boss';

/**
 * Cluster directory job - M0 stub
 * Full implementation in M0 spike.
 */
export async function clusterDirJob(
  job: any,
  db: any,
  worker: PgBoss,
  logger: Logger
): Promise<void> {
  logger.info({ jobId: job.id }, 'clusterDirJob stub');
}

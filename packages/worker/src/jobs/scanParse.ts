import type { Logger } from 'pino';
import type PgBoss from 'pg-boss';

/**
 * Scan parse job - M0 stub
 * Full implementation in M0 spike.
 */
export async function scanParseJob(
  job: any,
  db: any,
  worker: PgBoss,
  logger: Logger
): Promise<void> {
  logger.info({ jobId: job.id }, 'scanParseJob stub');
}

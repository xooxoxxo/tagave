import type { Logger } from 'pino';

/**
 * Progress tracking job - M0 stub
 * Full implementation in M0 spike.
 */
export async function progressJob(
  job: any,
  db: any,
  logger: Logger
): Promise<void> {
  logger.info({ jobId: job.id }, 'progressJob stub');
}

/**
 * mc.purge: drop Music Connections tombstones (mc_changes rows with op
 * 'delete') older than 90 days, the time the feeds promise to keep them
 * (spec §3). A cursor from before then gets 410 Gone and the linked app takes
 * a fresh snapshot, so nothing it needs is lost. Upserts are never purged: a
 * key keeps one row (the triggers compact it), and the snapshot reads them.
 *
 * Deletes in batches so no statement holds locks or bloats WAL for long.
 * Runs daily on the worker that serves facets.refresh (database upkeep).
 */
import type { WorkerContext } from '../lib/context.js';

export const MC_TOMBSTONE_DAYS = 90;

export interface McPurgeJobData {
  /** days a tombstone is kept (default 90) */
  keepDays?: number;
  /** rows per delete statement (default 5000) */
  batchSize?: number;
}

export async function mcPurgeJob(ctx: WorkerContext, data: McPurgeJobData = {}): Promise<{ deleted: number }> {
  const keepDays = data.keepDays ?? MC_TOMBSTONE_DAYS;
  const batchSize = data.batchSize ?? 5000;
  let deleted = 0;
  for (;;) {
    const rows = await ctx.sql`
      delete from mc_changes
       where id in (
         select id from mc_changes
          where op = 'delete' and changed_at < now() - make_interval(days => ${keepDays})
          limit ${batchSize})
      returning 1`;
    deleted += rows.length;
    if (rows.length < batchSize) break;
  }
  ctx.logger.info({ deleted, keepDays }, 'mc.purge: old Music Connections tombstones deleted');
  return { deleted };
}

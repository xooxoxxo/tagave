/**
 * mc.purge: keep the Music Connections change log small. The triggers only
 * append (migration 0048), so a key that changes often gathers rows; once a
 * day this
 *
 *   1. re-logs, as an upsert, any key whose newest row is a delete older than
 *      90 days yet which has data now (a writer's op can go stale when two
 *      write at once; the feed serves what is there, the log must not lose it),
 *   2. drops every row a newer row of the same key supersedes (capability,
 *      key, library, person): the feed serves a key's current data from its
 *      newest row, so the older ones say nothing more,
 *   3. drops delete rows older than 90 days whose key has no data, the time
 *      the feeds promise to keep tombstones (spec §3). A cursor from before
 *      then gets 410 Gone and the linked app takes a fresh snapshot.
 *
 * Writers never wait on this: they only insert. Deletes go in batches so no
 * statement holds locks or bloats WAL for long. Runs daily on the worker that
 * serves facets.refresh (database upkeep).
 */
import type { WorkerContext } from '../lib/context.js';

export const MC_TOMBSTONE_DAYS = 90;

export interface McPurgeJobData {
  /** days a tombstone is kept (default 90) */
  keepDays?: number;
  /** rows per delete statement (default 5000) */
  batchSize?: number;
}

export async function mcPurgeJob(
  ctx: WorkerContext,
  data: McPurgeJobData = {},
): Promise<{ relogged: number; superseded: number; tombstones: number }> {
  const keepDays = data.keepDays ?? MC_TOMBSTONE_DAYS;
  const batchSize = data.batchSize ?? 5000;

  const relogged = (await ctx.sql`
    insert into mc_changes (capability, key, op, user_id, library_id)
    select m.capability, m.key, 'upsert', m.user_id, m.library_id
      from mc_changes m
     where m.op = 'delete' and m.changed_at < now() - make_interval(days => ${keepDays})
       and not exists (select 1 from mc_changes n
                        where n.capability = m.capability and n.key = m.key and n.library_id = m.library_id
                          and n.user_id is not distinct from m.user_id and (n.changed_at, n.id) > (m.changed_at, m.id))
       and mc_present(m.capability, m.library_id, m.user_id, m.key)
    returning 1`).length;

  let superseded = 0;
  for (;;) {
    const rows = await ctx.sql`
      delete from mc_changes
       where id in (
         select m.id from mc_changes m
          where exists (select 1 from mc_changes n
                         where n.capability = m.capability and n.key = m.key and n.library_id = m.library_id
                           and n.user_id is not distinct from m.user_id and (n.changed_at, n.id) > (m.changed_at, m.id))
          limit ${batchSize})
      returning 1`;
    superseded += rows.length;
    if (rows.length < batchSize) break;
  }

  let tombstones = 0;
  for (;;) {
    const rows = await ctx.sql`
      delete from mc_changes
       where id in (
         select m.id from mc_changes m
          where m.op = 'delete' and m.changed_at < now() - make_interval(days => ${keepDays})
            and not mc_present(m.capability, m.library_id, m.user_id, m.key)
          limit ${batchSize})
      returning 1`;
    tombstones += rows.length;
    if (rows.length < batchSize) break;
  }

  ctx.logger.info({ relogged, superseded, tombstones, keepDays }, 'mc.purge: Music Connections change log compacted');
  return { relogged, superseded, tombstones };
}

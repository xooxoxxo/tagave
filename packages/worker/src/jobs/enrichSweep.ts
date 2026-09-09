/**
 * enrich.sweep: enqueue enrich.release for every release of record in the
 * library that still lacks its Discogs↔MB bridge (ENR-1). Restartable;
 * bridge_attempted_at keeps failed lookups from being retried daily.
 */
import type { WorkerContext } from '../lib/context.js';
import { reportProgress } from './progress.js';

export interface EnrichSweepJobData {
  /** one library, or every library when absent (the nightly schedule) */
  libraryId?: string;
  /** cap on releases to enqueue this sweep (default 500) */
  limit?: number;
}

export async function enrichSweepJob(ctx: WorkerContext, data: EnrichSweepJobData): Promise<void> {
  const libraries = data.libraryId
    ? [data.libraryId]
    : ((await ctx.sql`select id from libraries`) as unknown as Array<{ id: string }>).map((r) => r.id);
  for (const libraryId of libraries) await sweepLibrary(ctx, { ...data, libraryId });
}

async function sweepLibrary(ctx: WorkerContext, data: EnrichSweepJobData & { libraryId: string }): Promise<void> {
  const limit = data.limit ?? 500;
  // Discogs-only releases missing an MBID first (XO-379 pass 2: the reverse
  // bridge is what unlocks reviews, editions, artist pages and links for a
  // Discogs-first match), then MB releases missing a Discogs id; oldest
  // attempt first within each.
  const rows = await ctx.sql`
    select r.id
    from releases r
    where exists (
        select 1 from local_albums la
        where la.release_id = r.id and la.library_id = ${data.libraryId} and la.state = 'matched')
      and (r.discogs_release_id is null or r.mbid is null)
      and (r.bridge_attempted_at is null or r.bridge_attempted_at < now() - interval '30 days')
    order by (r.mbid is null) desc, r.bridge_attempted_at nulls first, r.fetched_at
    limit ${limit}` as unknown as Array<{ id: string }>;

  for (const r of rows) {
    await ctx.boss.send('enrich.release', { releaseId: r.id }, {
      singletonKey: `enrich:${r.id}`,
      retryLimit: 2,
      retryDelay: 120,
      retryBackoff: true,
    });
  }

  await reportProgress(ctx, null, {
    libraryId: data.libraryId,
    type: 'enrich.sweep',
    state: 'completed',
    done: rows.length,
    total: rows.length,
    message: `enqueued ${rows.length} releases for Discogs bridging`,
  });
  ctx.logger.info({ libraryId: data.libraryId, enqueued: rows.length }, 'enrich sweep');
}

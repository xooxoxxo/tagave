/**
 * cache.purge: drop provider_cache rows that expired more than a week ago
 * (audit 2026-10-10: 121k of 178k rows, 328 MB, were expired and nothing
 * ever deleted them). An expired row is never served by cached(); the week
 * of grace only keeps a just-expired answer around for debugging.
 *
 * Kept on purpose: MusicBrainz release payloads of releases still in the
 * catalogue. tracks.link fills recording/track MBIDs from them ignoring
 * expiry (fillTrackIdsFromCache), and refetching ~10k releases at 1 req/s
 * would compete with identify for a day.
 *
 * Deletes in batches so no statement holds locks or bloats WAL for long.
 * Runs nightly on the worker that serves facets.refresh.
 */
import type { WorkerContext } from '../lib/context.js';
import { CACHE_VERSION } from '../lib/providerCache.js';

export interface CachePurgeJobData {
  /** days past expires_at before a row goes (default 7) */
  graceDays?: number;
  /** rows per delete statement (default 5000) */
  batchSize?: number;
}

export async function cachePurgeJob(ctx: WorkerContext, data: CachePurgeJobData = {}): Promise<{ deleted: number }> {
  const graceDays = data.graceDays ?? 7;
  const batchSize = data.batchSize ?? 5000;
  const releasePrefix = `${CACHE_VERSION}:release:`;
  let deleted = 0;
  for (;;) {
    const rows = await ctx.sql`
      delete from provider_cache
       where id in (
         select pc.id from provider_cache pc
          where pc.expires_at < now() - make_interval(days => ${graceDays})
            and not (pc.provider = 'musicbrainz'
                     and pc.cache_key like ${releasePrefix + '%'}
                     and exists (select 1 from releases r
                                  where r.mbid = substr(pc.cache_key, ${releasePrefix.length + 1})))
          limit ${batchSize})
      returning 1`;
    deleted += rows.length;
    if (rows.length < batchSize) break;
  }
  ctx.logger.info({ deleted, graceDays }, 'cache.purge: expired provider_cache rows deleted');
  return { deleted };
}

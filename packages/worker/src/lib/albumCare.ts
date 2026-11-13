/**
 * "These albums changed" on the worker side (rr85): the same path as the
 * api's lib/albumCare.ts. A job that changed which files belong to an album,
 * or what the album is (cluster.dir, identify.album, files.move, files.split,
 * tags.revert, the trash), calls this with every album it touched, the ones
 * it removed included:
 *   - now: the album-level gaps (@tagave/db › recomputeAlbumGaps), cheap SQL;
 *   - queued: gaps.recompute scoped to those albums, for the quality flags.
 *     Its job.completed event is what the open pages refetch on.
 *
 * Best effort: the job's own work is done; a failure is logged and the
 * nightly check covers it.
 */
import { recomputeAlbumGaps } from '@tagave/db';
import type { WorkerContext } from './context.js';

export async function albumsChanged(
  ctx: Pick<WorkerContext, 'sql' | 'boss' | 'logger'>,
  libraryId: string,
  albumIds: ReadonlyArray<string | null | undefined>,
  opts: { queue?: boolean } = {},
): Promise<void> {
  const ids = [...new Set(albumIds.filter((id): id is string => !!id))].sort();
  if (ids.length === 0) return;
  try {
    await recomputeAlbumGaps(ctx.sql, libraryId, ids);
  } catch (err) {
    ctx.logger.warn({ err: (err as Error).message, libraryId, albumIds: ids }, 'could not recheck Library care for the changed albums');
  }
  if (opts.queue === false) return;
  try {
    await ctx.boss.send('gaps.recompute', { libraryId, albumIds: ids }, {});
  } catch (err) {
    ctx.logger.warn({ err: (err as Error).message, libraryId, albumIds: ids }, 'could not queue the quality check of the changed albums');
  }
}

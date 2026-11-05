/**
 * "These albums changed": the one path every album-changing route takes to
 * put Library care right (rr85). Library care's gaps are stored rows
 * (gaps.recompute); an operation that changes which files belong to an
 * album, or what the album is, leaves them stale until the next check.
 *
 * Two steps, both only for the albums the operation touched:
 *   - now, in the request: the album-level gaps (incomplete, duplicate,
 *     whole album in one file, gaps of albums that are gone), cheap SQL
 *     shared with the worker (@tagave/db › recomputeAlbumGaps), so the page
 *     that refetches right after the response sees the result;
 *   - queued: gaps.recompute scoped to the same albums, for the quality flags
 *     (tag lint). Its completion event refreshes the open pages again.
 *
 * Best effort: the operation itself is done and committed; a failure here is
 * logged and the nightly check still covers it.
 */
import { recomputeAlbumGaps } from '@tagave/db';
import { getSql } from '../db.js';
import { getBoss } from '../boss.js';

interface Log { warn: (obj: object, msg: string) => void }

export async function albumsChanged(libraryId: string, albumIds: ReadonlyArray<string | null | undefined>, log?: Log): Promise<void> {
  const ids = [...new Set(albumIds.filter((id): id is string => !!id))].sort();
  if (ids.length === 0) return;
  try {
    await recomputeAlbumGaps(getSql(), libraryId, ids);
  } catch (err) {
    log?.warn({ err: (err as Error).message, albumIds: ids }, 'could not recheck Library care for the changed albums');
  }
  try {
    const boss = await getBoss();
    // not among the queues the api creates at boot (as routes/gaps.ts)
    await boss.createQueue('gaps.recompute');
    await boss.send('gaps.recompute', { libraryId, albumIds: ids }, {});
  } catch (err) {
    log?.warn({ err: (err as Error).message, albumIds: ids }, 'could not queue the quality check of the changed albums');
  }
}

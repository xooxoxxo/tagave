/**
 * Weekly sweep that enqueues artist.refresh jobs for followed artists
 * whose discography is due for refresh (older than 7 days or never refreshed).
 * Gated by settings.discographyRefreshEnabled (default false).
 * Spec: XO-301 T1, spec §9.6 GAP-2, §10.3.
 */
import { and, eq } from 'drizzle-orm';
import { followedArtists, libraries } from '@liner/db';
import type { WorkerContext } from '../lib/context.js';

export interface ArtistsRefreshSweepJobData {
  /** one library, or every library when omitted (scheduled weekly) */
  libraryId?: string;
  /** cap on artists to enqueue this sweep (default 50) */
  limit?: number;
}

interface DueArtistRow {
  artistId: string;
  lastRefreshedAt: Date | null;
}

/**
 * Pure helper: select followed artists due for refresh.
 * Skips rows with lastRefreshedAt within the last 7 days.
 * Sorts by lastRefreshedAt (nulls first, oldest first).
 * Respects the limit.
 */
export function selectDueArtists(
  rows: DueArtistRow[],
  now: Date,
  limit: number
): DueArtistRow[] {
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Filter: keep rows where lastRefreshedAt is null or 7 or more days old (<=)
  const due = rows.filter((row) => {
    if (row.lastRefreshedAt === null) return true;
    return row.lastRefreshedAt <= sevenDaysAgo;
  });

  // Sort: nulls first, then oldest first
  due.sort((a, b) => {
    if (a.lastRefreshedAt === null && b.lastRefreshedAt === null) return 0;
    if (a.lastRefreshedAt === null) return -1;
    if (b.lastRefreshedAt === null) return 1;
    return a.lastRefreshedAt.getTime() - b.lastRefreshedAt.getTime();
  });

  return due.slice(0, limit);
}

/**
 * Enqueues artist.refresh jobs for followed artists whose discography
 * is due for refresh (older than 7 days or never refreshed).
 * Gated by library settings.discographyRefreshEnabled (default false).
 */
export async function artistsRefreshSweepJob(
  ctx: WorkerContext,
  data: ArtistsRefreshSweepJobData
): Promise<void> {
  const limit = data.limit ?? 50;
  const libs = data.libraryId
    ? [{ id: data.libraryId }]
    : await ctx.db.select({ id: libraries.id }).from(libraries);

  const now = new Date();
  let totalEnqueued = 0;
  let totalSkipped = 0;

  for (const lib of libs) {
    // Read library settings
    const libRows = await ctx.db.select({ settings: libraries.settings }).from(libraries).where(eq(libraries.id, lib.id));
    const libSettings = libRows[0]?.settings ?? {};
    const discographyRefreshEnabled = (libSettings as Record<string, any>)?.discographyRefreshEnabled ?? false;

    if (!discographyRefreshEnabled) {
      ctx.logger.info({ libraryId: lib.id }, 'artists refresh sweep: disabled');
      totalSkipped++;
      continue;
    }

    // Fetch all followed artists in the library with their last_refreshed_at
    const allFollowed = await ctx.db
      .select({
        artistId: followedArtists.artistId,
        lastRefreshedAt: followedArtists.lastRefreshedAt,
      })
      .from(followedArtists)
      .where(eq(followedArtists.libraryId, lib.id));

    // Select artists due for refresh using pure helper
    const due = selectDueArtists(allFollowed, now, limit);

    let enqueued = 0;
    for (const row of due) {
      try {
        const jobId = await ctx.boss.send(
          'artist.refresh',
          { libraryId: lib.id, artistId: row.artistId },
          {
            singletonKey: `artist.refresh:${row.artistId}`,
          }
        );
        if (jobId) enqueued++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.logger.warn({ libraryId: lib.id, artistId: row.artistId, err: msg }, 'artists.refresh sweep: enqueue failed');
      }
    }

    totalEnqueued += enqueued;
    ctx.logger.info(
      { libraryId: lib.id, enqueued, due: due.length, total: allFollowed.length },
      'artists refresh sweep'
    );
  }

  ctx.logger.info({ totalEnqueued, totalSkipped }, 'artists refresh sweep complete');
}

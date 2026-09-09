/**
 * tracks.link job: link local tracks to canonical tracks per album or batch sweep (0026).
 *
 * With `localAlbumId`: link one album (filling cache then aligning).
 * With `sweep`: batch-link matched albums per library, one pass per run.
 */

import { eq, and, isNotNull, or, isNull, lt, sql } from 'drizzle-orm';
import { localAlbums } from '@liner/db';
import { linkAlbumTracks, fillTrackIdsFromCache } from '../lib/trackLinks.js';
import type { WorkerContext } from '../lib/context.js';

export interface TracksLinkJobData {
  localAlbumId?: string;
  sweep?: boolean;
  limit?: number;
}

export async function tracksLinkJob(ctx: WorkerContext, data: TracksLinkJobData): Promise<void> {
  if (data.localAlbumId) {
    // Single album: fill cache, then link
    const album = (await ctx.db.select().from(localAlbums).where(eq(localAlbums.id, data.localAlbumId as any)))[0];
    if (!album) {
      ctx.logger.warn({ localAlbumId: data.localAlbumId }, 'album not found');
      return;
    }

    if (album.releaseId) {
      await fillTrackIdsFromCache(ctx, album.releaseId);
    }

    await linkAlbumTracks(ctx, data.localAlbumId);
  } else if (data.sweep) {
    // Batch sweep: per library, link unlinked albums
    const limit = data.limit ?? 300;

    // Get distinct libraries with matched albums
    const libraries = await ctx.db
      .selectDistinct({ libraryId: localAlbums.libraryId })
      .from(localAlbums)
      .where(
        and(
          eq(localAlbums.state, 'matched'),
          isNotNull(localAlbums.releaseId),
        ),
      );

    // Per library with DB-level filtering
    for (const { libraryId } of libraries) {
      if (!libraryId) continue;

      const releasesSeen = new Set<string>();
      let linked = 0;
      let tracksLinked = 0;
      let releasesFilled = 0;

      // Never linked, or re-identified since the last link. Both the filter and
      // the cap belong in SQL: this runs every 5 minutes against ~16k matched
      // albums, and selecting them all to slice in memory made the sweep's cost
      // grow with the library instead of with the work left to do.
      const filtered = await ctx.db
        .select()
        .from(localAlbums)
        .where(
          and(
            eq(localAlbums.libraryId, libraryId),
            eq(localAlbums.state, 'matched'),
            isNotNull(localAlbums.releaseId),
            or(
              isNull(localAlbums.tracksLinkedAt),
              lt(localAlbums.tracksLinkedAt, localAlbums.identifiedAt),
            ),
          ),
        )
        .orderBy(sql`${localAlbums.identifiedAt} desc nulls last`)
        .limit(limit);

      for (const album of filtered) {
        // Fill cache once per release
        if (album.releaseId && !releasesSeen.has(album.releaseId)) {
          releasesSeen.add(album.releaseId);
          const fillResult = await fillTrackIdsFromCache(ctx, album.releaseId);
          if (fillResult) {
            releasesFilled++;
          }
          // Deliberately NOT ensureTrackMbids() here. That refetches a release
          // from MusicBrainz, and this sweep walks every matched album: on prod
          // that is ~10.5k releases against one shared 1 req/s slot, competing
          // with identify. Filling from provider_cache is free and covers all
          // but one of those releases; the lazy refetch belongs to tags.preview,
          // where a person is waiting for a specific album's ids.
        }

        // Link the album
        const linkResult = await linkAlbumTracks(ctx, album.id);
        if (linkResult) {
          linked++;
          tracksLinked += linkResult.linked;
        }
      }

      // What is still waiting after this pass, counted in SQL rather than by
      // re-filtering a list we no longer hold.
      const [remainingRow] = (await ctx.sql`
        select count(*)::int as n from local_albums
         where library_id = ${libraryId} and state = 'matched' and release_id is not null
           and (tracks_linked_at is null or tracks_linked_at < identified_at)`) as unknown as Array<{ n: number }>;
      const remaining = remainingRow?.n ?? 0;

      ctx.logger.info(
        { libraryId, albumsLinked: linked, tracksLinked, releasesFilled, remaining },
        'tracks.link sweep complete',
      );
    }
  }
}

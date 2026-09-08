/**
 * Manual refresh of followed artist's discography from MusicBrainz (XO-348).
 * Fetches latest release groups and upserts them with idempotent natural-key logic.
 */
import { eq, and } from 'drizzle-orm';
import { artists, releaseGroups, releaseGroupArtists, followedArtists } from '@liner/db';
import type { WorkerContext } from '../lib/context.js';
import { mbCall, type Providers } from '../lib/providers.js';
import { cached, cacheKey, TTLs } from '../lib/providerCache.js';
import { getProviders, libraryProviderSettings } from '../lib/providers.js';
import { isRateLimitError } from '../lib/pacer.js';

export interface ArtistRefreshJobData {
  libraryId: string;
  artistId: string;
}

const bg = { priority: 'background' as const };

/**
 * Refresh a followed artist's discography: fetch MB release groups, upsert
 * to release_groups and release_group_artists (matching by mbid, idempotent),
 * filter to official releases, and update last_refreshed_at.
 */
export async function artistRefreshJob(ctx: WorkerContext, data: ArtistRefreshJobData): Promise<void> {
  const { libraryId, artistId } = data;

  // Load the artist
  const rows = await ctx.db.select().from(artists).where(eq(artists.id, artistId)).limit(1);
  const artist = rows[0];
  if (!artist) {
    ctx.logger.warn({ artistId }, 'artist.refresh: not found');
    return;
  }

  // Check artist is followed
  const followRows = await ctx.db.select().from(followedArtists)
    .where(and(eq(followedArtists.libraryId, libraryId), eq(followedArtists.artistId, artistId)))
    .limit(1);
  if (!followRows[0]) {
    ctx.logger.warn({ artistId, libraryId }, 'artist.refresh: not followed');
    return;
  }

  if (!artist.mbid) {
    ctx.logger.debug({ artistId }, 'artist.refresh: no mbid');
    return;
  }

  let providers: Providers;
  try {
    const settings = await libraryProviderSettings(ctx, libraryId);
    providers = getProviders(settings);
  } catch (err) {
    ctx.logger.warn({ artistId, err }, 'artist.refresh: providers failed');
    return;
  }

  try {
    // Fetch MB release groups for the artist
    const mbReleaseGroups = await cached(
      ctx.sql,
      'musicbrainz',
      cacheKey('artist-rgs', artist.mbid),
      TTLs.mbArtist,
      () => mbCall(ctx, () => providers.mb.getArtistReleaseGroups(artist.mbid!, bg)),
    );

    if (!mbReleaseGroups || mbReleaseGroups.length === 0) {
      ctx.logger.info({ artistId, mbid: artist.mbid }, 'artist.refresh: no release groups');
      // Still update last_refreshed_at
      await ctx.db.update(followedArtists)
        .set({ lastRefreshedAt: new Date() })
        .where(and(eq(followedArtists.libraryId, libraryId), eq(followedArtists.artistId, artistId)));
      return;
    }

    // Fetch full edition details for each release group to get primaryType
    // and filter to official releases only
    const releaseGroupsToUpsert: Array<{
      mbid: string;
      title: string;
      primaryType: string | null;
      secondaryTypes: string[];
      firstReleaseDate: string | null;
    }> = [];

    for (const rg of mbReleaseGroups) {
      if (!rg.sourceId) {
        ctx.logger.warn({ title: rg.title }, 'artist.refresh: missing sourceId');
        continue;
      }

      try {
        const editionData = await cached(
          ctx.sql,
          'musicbrainz',
          cacheKey('rg-editions', rg.sourceId),
          TTLs.mbRelease,
          () => mbCall(ctx, () => providers.mb.getReleaseGroupEditions(rg.sourceId!, bg)),
        );

        const primaryType = editionData.releaseGroup.primaryType || null;

        // Filter to official releases only
        if (primaryType && ['Album', 'EP', 'Single'].includes(primaryType)) {
          releaseGroupsToUpsert.push({
            mbid: rg.sourceId,
            title: rg.title,
            primaryType: primaryType as string,
            secondaryTypes: editionData.releaseGroup.secondaryTypes || [],
            firstReleaseDate: editionData.releaseGroup.firstReleaseDate || null,
          });
        }
      } catch (err) {
        ctx.logger.warn({ rgId: rg.sourceId, err }, 'artist.refresh: failed to fetch release group editions');
        // Continue with next RG rather than failing entire job
      }
    }

    // Upsert release groups with natural-key logic (by mbid)
    for (const rg of releaseGroupsToUpsert) {
      // Check if exists
      const existing = await ctx.db.select().from(releaseGroups)
        .where(eq(releaseGroups.mbid, rg.mbid))
        .limit(1);

      if (existing[0]) {
        // Update existing
        await ctx.db.update(releaseGroups)
          .set({
            title: rg.title,
            primaryType: rg.primaryType,
            secondaryTypes: rg.secondaryTypes,
            firstReleaseDate: rg.firstReleaseDate,
          })
          .where(eq(releaseGroups.mbid, rg.mbid));
      } else {
        // Insert new
        await ctx.db.insert(releaseGroups).values({
          mbid: rg.mbid,
          title: rg.title,
          primaryType: rg.primaryType,
          secondaryTypes: rg.secondaryTypes,
          firstReleaseDate: rg.firstReleaseDate,
        });
      }

      // Upsert release_group_artists
      const rgRow = await ctx.db.select().from(releaseGroups)
        .where(eq(releaseGroups.mbid, rg.mbid))
        .limit(1);

      if (rgRow[0]) {
        // Check if artist is already linked
        const existing = await ctx.db.select().from(releaseGroupArtists)
          .where(and(eq(releaseGroupArtists.releaseGroupId, rgRow[0].id), eq(releaseGroupArtists.artistId, artistId)))
          .limit(1);

        if (!existing[0]) {
          // Insert new artist link (position defaults to 0 for manual linking)
          await ctx.db.insert(releaseGroupArtists).values({
            releaseGroupId: rgRow[0].id,
            artistId,
            position: 0,
          });
        }
      }
    }

    // Update last_refreshed_at
    await ctx.db.update(followedArtists)
      .set({ lastRefreshedAt: new Date() })
      .where(and(eq(followedArtists.libraryId, libraryId), eq(followedArtists.artistId, artistId)));

    ctx.logger.info({ artistId, mbid: artist.mbid, upserted: releaseGroupsToUpsert.length }, 'artist.refresh: done');
  } catch (err) {
    // Rate-limit errors: rethrow for pg-boss retry
    if (isRateLimitError(err)) {
      throw err;
    }

    // Other errors: log and continue
    ctx.logger.warn({ artistId, mbid: artist.mbid, err }, 'artist.refresh: failed');
  }
}

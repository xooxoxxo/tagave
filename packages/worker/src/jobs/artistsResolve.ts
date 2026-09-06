/**
 * Resolve artists for release groups: fetch MusicBrainz release group credits
 * and upsert canonical artist links (spec XO-310, §5).
 */
import { and, eq, isNull, isNotNull, desc } from 'drizzle-orm';
import { releaseGroups, jobRuns, localAlbums } from '@liner/db';
import type { WorkerContext } from '../lib/context.js';
import { mbCall, type Providers } from '../lib/providers.js';
import { cached, cacheKey, TTLs } from '../lib/providerCache.js';
import { upsertCanonical } from '../lib/canonical.js';
import { reportProgress } from './progress.js';
import { getProviders, libraryProviderSettings } from '../lib/providers.js';

export interface ArtistsResolveJobData {
  /** one library, or every library when omitted (scheduled top-up) */
  libraryId?: string;
  /** cap on release groups to resolve this run (default 20) */
  limit?: number;
}

const bg = { priority: 'background' as const };

/**
 * Get providers for a library (with fallback to first library).
 */
async function getProvidersForLibrary(ctx: WorkerContext, libraryId?: string): Promise<{ id: string; providers: Providers }> {
  let lib: { id: string } | undefined;
  if (libraryId) {
    lib = { id: libraryId };
  } else {
    const rows = await ctx.sql`select id from libraries limit 1` as unknown as Array<{ id: string }>;
    lib = rows[0];
  }
  if (!lib) throw new Error('no library found');
  const settings = await libraryProviderSettings(ctx, lib.id);
  const providers = getProviders(settings);
  return { id: lib.id, providers };
}

/**
 * Count unresolved release groups in a library.
 */
async function countUnresolved(ctx: WorkerContext, libraryId: string): Promise<number> {
  const rows = await ctx.sql`
    select count(*)::int as cnt from release_groups
    where mbid is not null and artists_resolved_at is null` as unknown as Array<{ cnt: number }>;
  return rows[0]?.cnt ?? 0;
}

/**
 * Enqueues artists.resolve jobs for pending release groups (oldest first,
 * in-library first) and keeps one running job_runs row per library up to
 * date with progress.
 */
export async function artistsResolveJob(ctx: WorkerContext, data: ArtistsResolveJobData): Promise<void> {
  const limit = data.limit ?? 20;
  const libraryId = data.libraryId;

  // Find library context
  let lib: { id: string };
  if (libraryId) {
    lib = { id: libraryId };
  } else {
    const rows = await ctx.sql`select id from libraries limit 1` as unknown as Array<{ id: string }>;
    if (!rows[0]) {
      ctx.logger.warn({}, 'artists.resolve: no library found');
      return;
    }
    lib = rows[0];
  }

  const { providers } = await getProvidersForLibrary(ctx, lib.id);

  // Fetch pending release groups: in-library first (exists in local_albums),
  // oldest first by fetchedAt
  const inLibrary = await ctx.db
    .select({ id: releaseGroups.id, mbid: releaseGroups.mbid })
    .from(releaseGroups)
    .innerJoin(localAlbums, eq(releaseGroups.id, localAlbums.releaseGroupId))
    .where(and(
      eq(localAlbums.libraryId, lib.id),
      isNotNull(releaseGroups.mbid),
      isNull(releaseGroups.artistsResolvedAt),
    ))
    .orderBy(releaseGroups.fetchedAt)
    .limit(limit);

  let resolved = 0;
  let errors = 0;

  for (const rg of inLibrary) {
    try {
      // Fetch release group credits via cache
      const credits = await cached(
        ctx.sql,
        'musicbrainz',
        cacheKey('rg-credits', rg.mbid!),
        TTLs.mbRelease,
        () => mbCall(ctx, () => providers.mb.getReleaseGroupCredits(rg.mbid!, bg)),
      );

      // Convert to CanonicalRelease shape for upsertCanonical
      const canonical: any = {
        source: 'musicbrainz',
        id: rg.mbid,
        releaseGroupId: rg.mbid,
        title: credits.title,
        artists: credits.artistCredits?.map((ac: any) => ac.name) || [],
        artistCredits: credits.artistCredits,
        mbGenres: credits.mbGenres,
        mbTags: credits.mbTags,
      };

      // Upsert the canonical data (which includes artists and links)
      await upsertCanonical(ctx, canonical);

      resolved++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = (err as any)?.status;

      // 404: release group not found, mark as resolved anyway and log
      if (status === 404) {
        await ctx.db.update(releaseGroups)
          .set({ artistsResolvedAt: new Date() })
          .where(eq(releaseGroups.id, rg.id));
        ctx.logger.warn({ releaseGroupId: rg.id, mbid: rg.mbid }, 'artists.resolve: release group not found (404)');
        resolved++;
      } else if (/rate limit/i.test(msg) || /\b(503|429)\b/.test(msg)) {
        // Rate limit: rethrow for pg-boss retry
        throw err;
      } else {
        // Other errors: log and stop
        ctx.logger.warn({ releaseGroupId: rg.id, mbid: rg.mbid, err: msg }, 'artists.resolve: provider call failed');
        errors++;
        break; // Stop the run on error
      }
    }
  }

  // Update job_runs row
  const pending_count = await countUnresolved(ctx, lib.id);
  const done = resolved;
  const total = pending_count + resolved; // Approximate total
  const message = pending_count === 0
    ? 'all release groups resolved'
    : `${done} resolved · ${pending_count} pending`;

  const open = await ctx.db.select({ id: jobRuns.id }).from(jobRuns)
    .where(and(
      eq(jobRuns.libraryId, lib.id),
      eq(jobRuns.type, 'artists.resolve'),
    ))
    .orderBy(desc(jobRuns.createdAt))
    .limit(1);

  const rowId = open[0]?.id ?? null;
  await reportProgress(ctx, rowId, {
    libraryId: lib.id,
    type: 'artists.resolve',
    state: pending_count === 0 ? 'completed' : 'running',
    done,
    total,
    message,
  });

  ctx.logger.info({ libraryId: lib.id, resolved, pending: pending_count, errors }, 'artists resolve');
}

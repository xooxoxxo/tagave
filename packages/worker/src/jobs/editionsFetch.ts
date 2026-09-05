/**
 * Fetch editions for a release group from MusicBrainz.
 * Spec ENR-1, BRW-2, IDN-3.
 */
import { eq } from 'drizzle-orm';
import { releaseGroups, releases } from '@liner/db';
import type { Edition } from '@liner/core';
import type { WorkerContext } from '../lib/context.js';
import { mbCall, type Providers } from '../lib/providers.js';
import { cached, cacheKey, TTLs } from '../lib/providerCache.js';
import { libraryProviderSettings, getProviders } from '../lib/providers.js';
import { normDate, buildLabelsJsonb, buildMediaJsonb } from '../lib/canonical.js';

export interface EditionsFetchJobData {
  releaseGroupId: string; // db uuid
  force?: boolean;
}

const bg = { priority: 'background' as const };

/**
 * Fetch editions for a release group and upsert them into releases table.
 * ON CONFLICT (mbid) DO UPDATE only touches descriptive columns.
 */
export async function editionsFetchJob(ctx: WorkerContext, data: EditionsFetchJobData): Promise<void> {
  // 1. Load the release group
  const rgRow = await ctx.db.select().from(releaseGroups).where(eq(releaseGroups.id, data.releaseGroupId)).limit(1);
  if (!rgRow[0]) {
    ctx.logger.warn({ releaseGroupId: data.releaseGroupId }, 'editions.fetch: release group not found');
    return;
  }

  const rg = rgRow[0];

  // 2. Skip if Discogs-only RG (no mbid)
  if (!rg.mbid) {
    ctx.logger.debug({ releaseGroupId: data.releaseGroupId }, 'editions.fetch: discogs-only RG, skipping');
    // Still stamp fetched to avoid repeated attempts
    await ctx.db.update(releaseGroups).set({ editionsFetchedAt: new Date() }).where(eq(releaseGroups.id, data.releaseGroupId));
    return;
  }

  // 3. Skip if already fetched within 30 days, unless force
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  if (rg.editionsFetchedAt && rg.editionsFetchedAt > thirtyDaysAgo && !data.force) {
    ctx.logger.debug({ releaseGroupId: data.releaseGroupId, editionsFetchedAt: rg.editionsFetchedAt }, 'editions.fetch: recently fetched, skipping');
    return;
  }

  // 4. Library context: find libraryId from local_albums, fall back to first library
  let libraryId: string | undefined;
  const laRow = await ctx.sql`select library_id from local_albums where release_group_id = ${data.releaseGroupId} limit 1` as unknown as Array<{ library_id: string }>;
  if (laRow[0]?.library_id) {
    libraryId = laRow[0].library_id;
  } else {
    const libRow = await ctx.sql`select id from libraries limit 1` as unknown as Array<{ id: string }>;
    libraryId = libRow[0]?.id;
  }

  if (!libraryId) {
    ctx.logger.warn({ releaseGroupId: data.releaseGroupId }, 'editions.fetch: no library found');
    return;
  }

  const settings = await libraryProviderSettings(ctx, libraryId);
  let p: Providers;
  try {
    p = getProviders(settings);
  } catch (err) {
    ctx.logger.warn({ releaseGroupId: data.releaseGroupId, err }, 'editions.fetch: providers failed');
    return;
  }

  try {
    // 5. Fetch editions from MusicBrainz via cached call
    const result = await cached(
      ctx.sql,
      'musicbrainz',
      cacheKey('rg-editions', rg.mbid),
      TTLs.mbRelease,
      () => mbCall(ctx, () => p.mb.getReleaseGroupEditions(rg.mbid!, bg))
    );

    // 6. Update release group metadata if missing
    type UpdateSet = { editionsFetchedAt: Date; primaryType?: string | null; secondaryTypes?: string[]; firstReleaseDate?: string | null };
    const updateSet: UpdateSet = { editionsFetchedAt: new Date() };
    if (!rg.primaryType && result.releaseGroup.primaryType) {
      updateSet.primaryType = result.releaseGroup.primaryType;
    }
    if ((!rg.secondaryTypes || rg.secondaryTypes.length === 0) && result.releaseGroup.secondaryTypes) {
      updateSet.secondaryTypes = result.releaseGroup.secondaryTypes;
    }
    if (!rg.firstReleaseDate && result.releaseGroup.firstReleaseDate) {
      const normalized = normDate(result.releaseGroup.firstReleaseDate);
      if (normalized) updateSet.firstReleaseDate = normalized;
    }

    // 7. Upsert each edition into releases
    for (const edition of result.editions) {
      const dateStr = normDate(edition.date ?? undefined);
      const country = (edition.country && edition.country.length === 2) ? edition.country : null;

      // Build labels jsonb - Edition.labels has catalogNumber?: string | null, buildLabelsJsonb accepts catalogNumber?: string | undefined
      // Cast catalogNumber from string | null to string | undefined
      const labelsCast: Array<{ name: string; catalogNumber?: string | undefined }> = edition.labels.map((l) => {
        const catno = l.catalogNumber === null ? undefined : l.catalogNumber;
        return {
          name: l.name,
          ...(catno ? { catalogNumber: catno } : {}),
        };
      });
      // postgres.js sends JS arrays as Postgres arrays; jsonb needs a string + cast
      const labels = buildLabelsJsonb(labelsCast);

      // Build media jsonb - Edition.media has optional format and trackCount, buildMediaJsonb requires format and trackCount
      const mediaForJsonb: Array<{ position: number; format: string; trackCount: number }> = edition.media
        .filter((m): m is { position: number; format: string; trackCount: number } => !!(m.format && m.trackCount))
        .map((m) => ({ position: m.position, format: m.format, trackCount: m.trackCount }));
      const media = buildMediaJsonb(mediaForJsonb.length > 0 ? mediaForJsonb : undefined);

      const status = edition.status || null;
      const barcode = edition.barcode || null;
      const trackCount = edition.trackCount || null;
      const packaging = edition.packaging || null;

      await ctx.sql`
        insert into releases (release_group_id, mbid, title, status, date, country, barcode, labels, media, track_count, packaging, source_of_truth, fetched_at)
        values (${rg.id}, ${edition.mbid}, ${edition.title.slice(0, 255)}, ${status}, ${dateStr || null}, ${country}, ${barcode}, ${JSON.stringify(labels)}::jsonb, ${JSON.stringify(media)}::jsonb, ${trackCount}, ${packaging}, 'musicbrainz', now())
        on conflict (mbid) do update set
          title = excluded.title,
          status = excluded.status,
          date = excluded.date,
          country = excluded.country,
          barcode = excluded.barcode,
          labels = excluded.labels,
          media = excluded.media,
          track_count = excluded.track_count,
          packaging = excluded.packaging,
          fetched_at = excluded.fetched_at
      `;
    }

    // 8. Update RG fetched metadata
    await ctx.db.update(releaseGroups).set(updateSet).where(eq(releaseGroups.id, data.releaseGroupId));

    ctx.logger.info({
      releaseGroupId: data.releaseGroupId,
      rgMbid: rg.mbid,
      editionCount: result.editions.length,
    }, 'editions.fetch: success');
  } catch (err) {
    // Let rate limit errors propagate for retries
    const msg = err instanceof Error ? err.message : String(err);
    if (/\b(503|429)\b|rate limit/i.test(msg)) {
      throw err;
    }
    ctx.logger.warn({ releaseGroupId: data.releaseGroupId, err }, 'editions.fetch: provider call failed');
    // Still stamp fetched_at to avoid hammering the provider
    await ctx.db.update(releaseGroups).set({ editionsFetchedAt: new Date() }).where(eq(releaseGroups.id, data.releaseGroupId));
  }
}

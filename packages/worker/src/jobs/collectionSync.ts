/**
 * Sync Discogs collection and map items to canonical releases (spec COL-1, GAP-3).
 */
import { eq, and, notInArray, sql as dsql, sql, lt } from 'drizzle-orm';
import {
  libraries, collectionSources, collectionItems, releases, releaseGroups,
} from '@liner/db';
import { conditionsFromNotes } from '@liner/core';
import { openSecret } from '@liner/core';
import type { WorkerContext } from '../lib/context.js';
import { reportProgress } from './progress.js';
import {
  getProviders, discogsCall, type Providers,
} from '../lib/providers.js';
import { libraryProviderSettings } from '../lib/providers.js';
import { cached, cacheKey, TTLs, stripDiscogs } from '../lib/providerCache.js';

export interface CollectionSyncJobData {
  libraryId: string;
  force?: boolean;
  remapOnly?: boolean;
}

const bg = { priority: 'background' as const };
const { randomUUID } = await import('crypto');

function discogsRelease(ctx: WorkerContext, p: Providers, id: number | string) {
  return cached(ctx.sql, 'discogs', cacheKey('release', id), TTLs.discogsEntity,
    () => discogsCall(ctx, p, () => p.discogs.getRelease(String(id), bg)),
    { strip: stripDiscogs });
}

export async function collectionSyncJob(ctx: WorkerContext, data: CollectionSyncJobData): Promise<void> {
  const { libraryId, remapOnly = false } = data;
  let jobRunId: string | null = null;

  try {
    const libRows = await ctx.db.select().from(libraries).where(eq(libraries.id, libraryId));
    if (libRows.length === 0) {
      await reportProgress(ctx, jobRunId, {
        libraryId,
        type: 'collection.sync',
        state: 'failed',
        error: 'Library not found',
      });
      return;
    }

    const lib = libRows[0]!;
    const settings = typeof lib.settings === 'string' ? JSON.parse(lib.settings) : (lib.settings ?? {});
    const discogsTokenSealed = (settings as Record<string, any>)['discogsToken'];
    if (!discogsTokenSealed) {
      await reportProgress(ctx, jobRunId, {
        libraryId,
        type: 'collection.sync',
        state: 'failed',
        error: 'Discogs token not configured',
      });
      return;
    }

    // The settings loader opens the sealed token with this host's APP_SECRET
    // and carries the contact string the providers refuse to run without.
    const providerSettings = await libraryProviderSettings(ctx, libraryId);
    if (!providerSettings.discogsToken) {
      await reportProgress(ctx, jobRunId, {
        libraryId, type: 'collection.sync', state: 'failed',
        error: 'Discogs token could not be opened on this host (APP_SECRET missing or different) — see liner-doctor',
      });
      return;
    }
    const providers = getProviders(providerSettings);

    if (remapOnly) {
      await doMapping(ctx, jobRunId, libraryId);
      return;
    }

    jobRunId = await reportProgress(ctx, jobRunId, {
      libraryId,
      type: 'collection.sync',
      state: 'running',
      message: 'Getting user identity',
    });

    const identity = await discogsCall(ctx, providers,
      () => providers.discogs.getIdentity(bg));

    const existingSources = await ctx.db.select().from(collectionSources)
      .where(and(eq(collectionSources.libraryId, libraryId), eq(collectionSources.provider, 'discogs')));

    const sourceId = existingSources[0]?.id ?? randomUUID();
    if (existingSources.length === 0) {
      await ctx.db.insert(collectionSources).values({
        id: sourceId, libraryId, provider: 'discogs', username: identity.username, status: 'syncing',
      });
    } else {
      await ctx.db.update(collectionSources).set({ username: identity.username, status: 'syncing' })
        .where(eq(collectionSources.id, sourceId));
    }

    jobRunId = await reportProgress(ctx, jobRunId, {
      libraryId,
      type: 'collection.sync',
      state: 'running',
      message: 'Fetching collection metadata',
    });

    const folders = await discogsCall(ctx, providers,
      () => providers.discogs.listCollectionFolders(identity.username, bg));
    const fields = await discogsCall(ctx, providers,
      () => providers.discogs.getCollectionFields(identity.username, bg));

    await ctx.db.update(collectionSources).set({ folders })
      .where(eq(collectionSources.id, sourceId));

    const syncStart = new Date();
    let page = 1;
    let pages = 1;
    const seenIds = new Set<string>();

    while (page <= pages) {
      jobRunId = await reportProgress(ctx, jobRunId, {
        libraryId, type: 'collection.sync', state: 'running',
        done: (page - 1) * 100, total: pages * 100,
        message: `Fetching page ${page}/${pages}`,
      });

      const result = await discogsCall(ctx, providers,
        () => providers.discogs.listCollectionPage(identity.username, 0, page, bg));

      pages = result.pages;

      for (const item of result.items) {
        const providerItemId = String(item.instanceId);
        seenIds.add(providerItemId);

        const conditions = conditionsFromNotes(item.notes, fields);
        const basicInfo = {
          title: item.title, artists: item.artists,
          ...(item.year ? { year: item.year } : {}),
          labels: item.labels, formats: item.formats,
          genres: item.genres, styles: item.styles,
          ...(item.thumbUrl ? { thumbUrl: item.thumbUrl } : {}),
          ...(item.coverUrl ? { coverUrl: item.coverUrl } : {}),
        };

        const existing = await ctx.db.select().from(collectionItems)
          .where(and(eq(collectionItems.collectionSourceId, sourceId), eq(collectionItems.providerItemId, providerItemId)));

        const folderName = folders.find(f => f.id === item.folderId)?.name ?? 'Unknown';
        const baseData = {
          libraryId, collectionSourceId: sourceId, providerItemId,
          discogsReleaseId: item.releaseId, discogsMasterId: item.masterId ?? null,
          folderId: item.folderId, folderName, formats: item.formats, basicInfo,
          mediaCondition: conditions.mediaCondition ?? null,
          sleeveCondition: conditions.sleeveCondition ?? null,
          notes: conditions.notes ?? null, rating: item.rating ?? null,
          dateAdded: new Date(item.dateAdded), lastSeenAt: syncStart, removedAt: null,
        };

        if (existing.length === 0) {
          await ctx.db.insert(collectionItems).values({ id: randomUUID(), ...baseData, mappingState: 'unmapped' });
        } else {
          await ctx.db.update(collectionItems).set(baseData)
            .where(and(eq(collectionItems.collectionSourceId, sourceId), eq(collectionItems.providerItemId, providerItemId)));
        }
      }

      page++;
    }

    // Mark removed items (spec GAP-3: use last_seen_at instead of seenIds to handle partial syncs)
    // Items unseen in this run stay unseen until absent in a complete run
    // Skip items with push_state 'pending'/'failed' (no instance id yet) — they were never synced to Discogs
    await ctx.db.update(collectionItems)
      .set({ removedAt: new Date() })
      .where(and(
        eq(collectionItems.collectionSourceId, sourceId),
        lt(collectionItems.lastSeenAt, syncStart), // typed column: drizzle serialises the Date; a raw sql fragment cannot
        dsql`removed_at is null`,
        eq(collectionItems.pushState, 'synced') // only mark synced items as removed
      ));

    await ctx.db.update(collectionSources)
      .set({ lastSyncAt: syncStart, itemCount: seenIds.size, status: 'ok', lastError: null })
      .where(eq(collectionSources.id, sourceId));

    await doMapping(ctx, jobRunId, libraryId);
  } catch (err) {
    ctx.logger.error({ err }, 'collection.sync failed');

    // Update source status to error (spec COL-1: persist error state for UI)
    const sourceRows = await ctx.db.select().from(collectionSources)
      .where(and(eq(collectionSources.libraryId, libraryId), eq(collectionSources.provider, 'discogs')));
    if (sourceRows.length > 0) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await ctx.db.update(collectionSources)
        .set({ status: 'error', lastError: errMsg })
        .where(eq(collectionSources.id, sourceRows[0]!.id));
    }

    throw err;
  }
}

async function doMapping(ctx: WorkerContext, jobRunId: string | null, libraryId: string): Promise<void> {
  jobRunId = await reportProgress(ctx, jobRunId, {
    libraryId, type: 'collection.sync', state: 'running',
    message: 'Mapping collection items',
  });

  const unmapped = await ctx.db.select().from(collectionItems)
    .where(and(
      eq(collectionItems.libraryId, libraryId),
      eq(collectionItems.mappingState, 'unmapped'),
      dsql`removed_at is null`
    ));

  let mapped = 0;
  const methods = new Map<string, number>();
  // Same loader as the pull phase: opens the sealed token and carries the
  // contact string; mapping only needs Discogs for the release fetch and
  // MusicBrainz for the URL lookup.
  const providerSettings = await libraryProviderSettings(ctx, libraryId);
  const providers = getProviders(providerSettings);

  for (const item of unmapped) {
    // Step (a): Try direct release_id lookup
    if (item.discogsReleaseId) {
      const rel = await ctx.db.select().from(releases)
        .where(eq(releases.discogsReleaseId, item.discogsReleaseId));

      if (rel.length > 0) {
        await ctx.db.update(collectionItems)
          .set({
            releaseId: rel[0]!.id, releaseGroupId: rel[0]!.releaseGroupId,
            mappingState: 'auto', mappingSource: 'release_id', mappedAt: new Date(),
          })
          .where(eq(collectionItems.id, item.id));
        mapped++;
        methods.set('release_id', (methods.get('release_id') ?? 0) + 1);
        continue;
      }
    }

    // Step (b): Try master_id lookup
    const masterId = item.discogsMasterId;
    if (masterId && masterId > 0) {
      const rg = await ctx.db.select().from(releaseGroups)
        .where(eq(releaseGroups.discogsmasterId, masterId));

      if (rg.length > 0) {
        await ctx.db.update(collectionItems)
          .set({
            releaseGroupId: rg[0]!.id,
            mappingState: 'auto', mappingSource: 'master_id', mappedAt: new Date(),
          })
          .where(eq(collectionItems.id, item.id));
        mapped++;
        methods.set('master_id', (methods.get('master_id') ?? 0) + 1);
        continue;
      }
    }

    // Step (c): Fetch Discogs release to get master_id, then retry (b)
    if (item.discogsReleaseId) {
      try {
        const dr = await discogsRelease(ctx, providers, item.discogsReleaseId);
        const fetchedMasterId = dr.discogsMasterId ? parseInt(dr.discogsMasterId, 10) : null;
        if (fetchedMasterId && fetchedMasterId > 0) {
          const rg = await ctx.db.select().from(releaseGroups)
            .where(eq(releaseGroups.discogsmasterId, fetchedMasterId));

          if (rg.length > 0) {
            await ctx.db.update(collectionItems)
              .set({
                discogsMasterId: fetchedMasterId, releaseGroupId: rg[0]!.id,
                mappingState: 'auto', mappingSource: 'discogs_release_fetch', mappedAt: new Date(),
              })
              .where(eq(collectionItems.id, item.id));
            mapped++;
            methods.set('discogs_release_fetch', (methods.get('discogs_release_fetch') ?? 0) + 1);
            continue;
          }
        }
      } catch (err) {
        ctx.logger.warn({ itemId: item.id, discogsId: item.discogsReleaseId, err }, 'Discogs release fetch failed, continuing');
      }
    }

    // Step (d): MB reverse bridge lookup via Discogs URL
    if (item.discogsReleaseId) {
      try {
        const discogsUrl = `https://www.discogs.com/release/${item.discogsReleaseId}`;
        const { mbCall } = await import('../lib/providers.js');
        const { mbRelease, persistFetched } = await import('./identifyAlbum.js');

        const lookupFn = async () => mbCall(ctx, () => providers.mb.lookupUrl(discogsUrl, { priority: 'background' }));
        const mbResult = await cached(
          ctx.sql,
          'musicbrainz',
          cacheKey('url', discogsUrl),
          TTLs.mbUrl,
          lookupFn,
          { strip: (x: any) => x }
        );

        // MB lookup returns { releaseMbids: string[], releaseGroupMbids: string[] }
        if (mbResult && Array.isArray(mbResult.releaseMbids) && mbResult.releaseMbids.length > 0) {
          const mbid = mbResult.releaseMbids[0];
          if (mbid) {
            const mbRel = await mbRelease(ctx, providers, mbid);

            if (mbRel && mbRel.id) {
              // Persist the fetched release
              await persistFetched(ctx, mbRel);

              // Map using the newly persisted release
              const rel = await ctx.db.select().from(releases).where(eq(releases.id, mbRel.id));
              if (rel.length > 0) {
                await ctx.db.update(collectionItems)
                  .set({
                    releaseId: rel[0]!.id, releaseGroupId: rel[0]!.releaseGroupId,
                    mappingState: 'auto', mappingSource: 'mb_url', mappedAt: new Date(),
                  })
                  .where(eq(collectionItems.id, item.id));
                mapped++;
                methods.set('mb_url', (methods.get('mb_url') ?? 0) + 1);
                continue;
              }
            }
          }
        }
      } catch (err) {
        ctx.logger.warn({ itemId: item.id, discogsId: item.discogsReleaseId, err }, 'MB URL lookup failed, continuing');
      }
    }
  }

  ctx.logger.info({ libraryId, mapped, unmapped: unmapped.length - mapped, methods: Object.fromEntries(methods) }, 'mapping complete');

  jobRunId = await reportProgress(ctx, jobRunId, {
    libraryId, type: 'collection.sync', state: 'completed',
    message: `Mapped ${mapped}/${unmapped.length}`,
  });
}

export interface CollectionPushJobData {
  libraryId: string;
  itemId: string;
}

/**
 * Push collection item to Discogs (spec COL-3).
 */
export async function collectionPushJob(ctx: WorkerContext, data: CollectionPushJobData): Promise<void> {
  const { libraryId, itemId } = data;
  const logger = ctx.logger.child({ jobType: 'collection.push', libraryId, itemId });

  try {
    const itemRows = await ctx.db.select().from(collectionItems)
      .where(eq(collectionItems.id, itemId));

    if (itemRows.length === 0) {
      logger.warn('Item not found');
      return;
    }

    const item = itemRows[0]!;

    // Get library and settings
    const libRows = await ctx.db.select().from(libraries)
      .where(eq(libraries.id, libraryId));

    if (libRows.length === 0) {
      logger.warn('Library not found');
      return;
    }

    const settings = await libraryProviderSettings(ctx, libraryId);
    const providers = getProviders(settings);

    // Get identity and ensure fields are cached in collection_sources
    const identity = await discogsCall(ctx, providers, () => providers.discogs.getIdentity(bg));

    // Get or update source fields
    const sources = await ctx.db.select().from(collectionSources)
      .where(eq(collectionSources.id, item.collectionSourceId));

    if (sources.length === 0) {
      throw new Error('Collection source not found');
    }

    const source = sources[0]!;
    const fieldsList = await discogsCall(ctx, providers, () =>
      providers.discogs.getCollectionFields(identity.username, bg));

    // Update source with fields
    const fields = source.fields || [];
    if (Array.isArray(fields) && fields.length === 0) {
      await ctx.db.update(collectionSources)
        .set({ fields: fieldsList as any })
        .where(eq(collectionSources.id, item.collectionSourceId));
    }

    // Add to Discogs collection
    const addResult = await discogsCall(ctx, providers, () =>
      providers.discogs.addToCollection(
        identity.username,
        item.folderId || 1,
        item.discogsReleaseId!,
        bg
      ));

    const instanceId = addResult.instanceId;

    // Immediately persist the instanceId before field/rating writes to prevent duplicates on retry
    await ctx.db.update(collectionItems)
      .set({ providerItemId: String(instanceId) })
      .where(eq(collectionItems.id, itemId));

    // Set custom fields
    let fieldErrors: string[] = [];
    if (item.mediaCondition || item.sleeveCondition || item.notes) {
      // Find field IDs by name (case-insensitive)
      const fieldMap = new Map(fieldsList.map(f => [f.name.toLowerCase(), f]));

      if (item.mediaCondition) {
        const mediaField = Array.from(fieldMap.values()).find(f =>
          f.name.toLowerCase().includes('media condition')
        );
        if (mediaField) {
          // Validate dropdown value is in options
          if (mediaField.type === 'dropdown' && mediaField.options && !mediaField.options.includes(item.mediaCondition)) {
            fieldErrors.push(`Invalid media condition "${item.mediaCondition}": not in available options`);
          } else {
            try {
              await discogsCall(ctx, providers, () =>
                providers.discogs.setCollectionField(
                  identity.username,
                  item.folderId || 1,
                  item.discogsReleaseId!,
                  instanceId,
                  mediaField.id,
                  item.mediaCondition!,
                  bg
                )
              );
            } catch (err: any) {
              fieldErrors.push(`Failed to set media condition: ${err?.message || String(err)}`);
            }
          }
        }
      }

      if (item.sleeveCondition) {
        const sleeveField = Array.from(fieldMap.values()).find(f =>
          f.name.toLowerCase().includes('sleeve condition')
        );
        if (sleeveField) {
          // Validate dropdown value is in options
          if (sleeveField.type === 'dropdown' && sleeveField.options && !sleeveField.options.includes(item.sleeveCondition)) {
            fieldErrors.push(`Invalid sleeve condition "${item.sleeveCondition}": not in available options`);
          } else {
            try {
              await discogsCall(ctx, providers, () =>
                providers.discogs.setCollectionField(
                  identity.username,
                  item.folderId || 1,
                  item.discogsReleaseId!,
                  instanceId,
                  sleeveField.id,
                  item.sleeveCondition!,
                  bg
                )
              );
            } catch (err: any) {
              fieldErrors.push(`Failed to set sleeve condition: ${err?.message || String(err)}`);
            }
          }
        }
      }

      if (item.notes) {
        const notesField = Array.from(fieldMap.values()).find(f =>
          f.name.toLowerCase() === 'notes'
        );
        if (notesField) {
          try {
            await discogsCall(ctx, providers, () =>
              providers.discogs.setCollectionField(
                identity.username,
                item.folderId || 1,
                item.discogsReleaseId!,
                instanceId,
                notesField.id,
                item.notes!,
                bg
              )
            );
          } catch (err: any) {
            fieldErrors.push(`Failed to set notes: ${err?.message || String(err)}`);
          }
        }
      }
    }

    // Set rating if provided
    if (item.rating && item.rating > 0) {
      await discogsCall(ctx, providers, () =>
        providers.discogs.setCollectionRating(
          identity.username,
          item.folderId || 1,
          item.discogsReleaseId!,
          instanceId,
          item.rating!,
          bg
        )
      );
    }

    // Fetch release basic info
    let basicInfo: Record<string, unknown> | undefined;
    try {
      const release = await discogsRelease(ctx, providers, item.discogsReleaseId!);
      basicInfo = {
        title: release.title,
        artists: release.artists,
        year: release.year,
        formats: release.mediaList,
        thumb: release.images?.find(i => i.primary)?.url,
      };
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch basic info');
    }

    // Mark as synced or failed based on field errors
    const hasFatalErrors = fieldErrors.length > 0;
    const pushError = hasFatalErrors ? fieldErrors.join('; ') : null;

    await ctx.db.update(collectionItems)
      .set({
        pushState: hasFatalErrors ? 'failed' : 'synced',
        pushError,
        dateAdded: new Date(),
        lastSeenAt: new Date(),
        ...(basicInfo ? { basicInfo } : {}),
      })
      .where(eq(collectionItems.id, itemId));

    if (hasFatalErrors) {
      logger.warn({ instanceId, errors: fieldErrors }, 'Item pushed with field errors');
    } else {
      logger.info({ instanceId }, 'Item pushed to Discogs');
    }
  } catch (err: any) {
    logger.error({ err }, 'Push failed');

    // Set error state
    let errorMsg = err?.message || 'Unknown error';
    if (err?.retryAfterMs) {
      // Rate limit — let pg-boss retry
      throw err;
    }

    await ctx.db.update(collectionItems)
      .set({
        pushState: 'failed',
        pushError: errorMsg.substring(0, 500),
      })
      .where(eq(collectionItems.id, itemId))
      .catch(e => logger.warn({ e }, 'Failed to set error state'));
  }
}

export interface CollectionRemoveJobData {
  libraryId: string;
  itemId: string;
}

/**
 * Remove collection item from Discogs (spec COL-3).
 */
export async function collectionRemoveJob(ctx: WorkerContext, data: CollectionRemoveJobData): Promise<void> {
  const { libraryId, itemId } = data;
  const logger = ctx.logger.child({ jobType: 'collection.remove', libraryId, itemId });

  try {
    const itemRows = await ctx.db.select().from(collectionItems)
      .where(eq(collectionItems.id, itemId));

    if (itemRows.length === 0) {
      logger.warn('Item not found');
      return;
    }

    const item = itemRows[0]!;

    if (!item.providerItemId) {
      logger.warn('Provider item ID not set');
      return;
    }

    // Get library and settings
    const libRows = await ctx.db.select().from(libraries)
      .where(eq(libraries.id, libraryId));

    if (libRows.length === 0) {
      logger.warn('Library not found');
      return;
    }

    const settings = await libraryProviderSettings(ctx, libraryId);
    const providers = getProviders(settings);

    // Get identity
    const identity = await discogsCall(ctx, providers, () => providers.discogs.getIdentity(bg));

    // Remove from Discogs
    try {
      await discogsCall(ctx, providers, () =>
        providers.discogs.removeFromCollection(
          identity.username!,
          item.folderId || 1,
          item.discogsReleaseId!,
          parseInt(item.providerItemId!, 10),
          bg
        )
      );
    } catch (err: any) {
      // 404 = already removed, treat as success
      if (err?.status !== 404) {
        throw err;
      }
    }

    // Mark as removed
    await ctx.db.update(collectionItems)
      .set({
        removedAt: new Date(),
        pushState: 'synced',
      })
      .where(eq(collectionItems.id, itemId));

    logger.info('Item removed from Discogs');
  } catch (err: any) {
    logger.error({ err }, 'Remove failed');

    if (err?.retryAfterMs) {
      throw err;
    }

    // Set error state
    let errorMsg = err?.message || 'Unknown error';
    await ctx.db.update(collectionItems)
      .set({
        pushState: 'failed',
        pushError: errorMsg.substring(0, 500),
      })
      .where(eq(collectionItems.id, itemId))
      .catch(e => logger.warn({ e }, 'Failed to set error state'));
  }
}

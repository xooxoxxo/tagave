/**
 * Enrich release with Discogs data via bridging.
 * Spec ENR-1.
 */
import { eq } from 'drizzle-orm';
import { releases, releaseGroups, externalIds } from '@liner/db';
import {
  fuzzyBridgeScore, FUZZY_BRIDGE_ACCEPT, discogsIdsFromUrlRelations, wikidataQidFromUrlRelations,
} from '@liner/core';
import type { CanonicalRelease } from '@liner/core';
import type { WorkerContext } from '../lib/context.js';
import { mbCall, discogsCall, wikidataCall, type Providers } from '../lib/providers.js';
import { cached, cacheKey, TTLs, stripDiscogs } from '../lib/providerCache.js';
import { libraryProviderSettings, getProviders } from '../lib/providers.js';
import { upsertCanonical, upsertDiscogsSidecars } from '../lib/canonical.js';
import {
  mbRelease, discogsRelease, discogsMaster, discogsSearch, persistFetched,
} from './identifyAlbum.js';

export interface EnrichReleaseJobData {
  releaseId: string;
  force?: boolean;
}

const bg = { priority: 'background' as const };

/** Normalize catalog number for comparison: uppercase, strip spaces/dashes. */
export function normalizeCatno(s: string): string {
  return s.toUpperCase().replace(/[\s-]/g, '');
}

/**
 * Find a search hit with barcode matching digit-for-digit.
 * Returns the hit or undefined.
 */
export function pickBarcodeHit(
  hits: Array<CanonicalRelease>,
  barcode: string
): CanonicalRelease | undefined {
  const normalized = barcode.replace(/\D/g, '');
  if (!normalized) return undefined;

  for (const hit of hits) {
    if (hit.barcode) {
      const hitNorm = hit.barcode.replace(/\D/g, '');
      if (hitNorm === normalized) return hit;
    }
  }
  return undefined;
}

/**
 * Find a search hit with catalog number matching case-insensitively,
 * and fuzzy score >= 0.7 vs the MB metadata.
 * Returns the hit or undefined.
 */
export function pickCatnoHit(
  hits: Array<CanonicalRelease>,
  catno: string,
  mbMeta: { title: string; artists: string[]; year?: number }
): CanonicalRelease | undefined {
  const normalized = normalizeCatno(catno);
  if (!normalized) return undefined;

  for (const hit of hits) {
    if (hit.catalogNumber && normalizeCatno(hit.catalogNumber) === normalized) {
      // Check fuzzy score >= 0.7
      const hitMeta: { title: string; artists: string[]; year?: number } = {
        title: hit.title,
        artists: hit.artists,
        ...(hit.year !== undefined ? { year: hit.year } : {}),
      };
      const score = fuzzyBridgeScore(mbMeta, hitMeta);
      if (score >= 0.7) return hit;
    }
  }
  return undefined;
}

/**
 * Find the best fuzzy match from hits >= FUZZY_BRIDGE_ACCEPT.
 * When preferredMasterId is known, prefer hits with matching master first.
 * Returns { hit, score } or undefined.
 */
export function pickFuzzyHit(
  hits: Array<CanonicalRelease>,
  mbMeta: { title: string; artists: string[]; year?: number },
  preferredMasterId?: number | string
): { hit: CanonicalRelease; score: number } | undefined {
  let bestHit: CanonicalRelease | undefined;
  let bestScore = -1;
  let bestMatchesPreferred: boolean = false;

  for (const hit of hits) {
    const hitMeta: { title: string; artists: string[]; year?: number } = {
      title: hit.title,
      artists: hit.artists,
      ...(hit.year !== undefined ? { year: hit.year } : {}),
    };
    const score = fuzzyBridgeScore(mbMeta, hitMeta);
    if (score < FUZZY_BRIDGE_ACCEPT) continue;

    const matchesPreferred: boolean = !!(
      preferredMasterId
      && hit.discogsMasterId
      && String(hit.discogsMasterId) === String(preferredMasterId)
    );

    // Prefer hits matching the preferred master; secondary sort by score
    if (!bestHit
      || (matchesPreferred && !bestMatchesPreferred)
      || (matchesPreferred === bestMatchesPreferred && score > bestScore)) {
      bestHit = hit;
      bestScore = score;
      bestMatchesPreferred = matchesPreferred;
    }
  }

  return bestHit ? { hit: bestHit, score: bestScore } : undefined;
}

/** ENR-2 follow-up: albums of this release still without front art get a
 * fresh art.fetch now that a Discogs image source exists. */
async function enqueueArtForRelease(ctx: WorkerContext, releaseId: string): Promise<void> {
  const rows = await ctx.sql`
    select la.id from local_albums la
    where la.release_id = ${releaseId}
      and not exists (select 1 from images i where i.local_album_id = la.id and i.kind = 'front')
  ` as unknown as Array<{ id: string }>;
  for (const la of rows) {
    await ctx.boss.send('art.fetch', { localAlbumId: la.id }, { singletonKey: `art:${la.id}` });
  }
}

export async function enrichReleaseJob(ctx: WorkerContext, data: EnrichReleaseJobData): Promise<void> {
  // 1. Load the release + RG
  const relRow = await ctx.db.select().from(releases).where(eq(releases.id, data.releaseId)).limit(1);
  if (!relRow[0]) {
    ctx.logger.warn({ releaseId: data.releaseId }, 'enrich: release not found');
    return;
  }

  const release = relRow[0];
  const rgRow = await ctx.db.select().from(releaseGroups).where(eq(releaseGroups.id, release.releaseGroupId)).limit(1);
  const rg = rgRow[0];
  if (!rg) {
    ctx.logger.warn({ releaseId: data.releaseId, releaseGroupId: release.releaseGroupId }, 'enrich: release group not found');
    return;
  }

  // 2. Skip if already has both mbid and discogs_release_id and not force
  if (release.mbid && release.discogsReleaseId && !data.force) {
    ctx.logger.debug({ releaseId: data.releaseId }, 'enrich: already has both mbid and discogs id');
    await ctx.db.update(releases).set({ bridgeAttemptedAt: new Date() }).where(eq(releases.id, data.releaseId));
    return;
  }

  // 3. Library context: find libraryId from local_albums, fall back to first library
  let libraryId: string | undefined;
  const laRow = await ctx.sql`select library_id from local_albums where release_id = ${data.releaseId} limit 1` as unknown as Array<{ library_id: string }>;
  if (laRow[0]?.library_id) {
    libraryId = laRow[0].library_id;
  } else {
    const libRow = await ctx.sql`select id from libraries limit 1` as unknown as Array<{ id: string }>;
    libraryId = libRow[0]?.id;
  }

  if (!libraryId) {
    ctx.logger.warn({ releaseId: data.releaseId }, 'enrich: no library found');
    await ctx.db.update(releases).set({ bridgeAttemptedAt: new Date() }).where(eq(releases.id, data.releaseId));
    return;
  }

  const settings = await libraryProviderSettings(ctx, libraryId);
  let p: Providers;
  try {
    p = getProviders(settings);
  } catch (err) {
    ctx.logger.warn({ releaseId: data.releaseId, err }, 'enrich: providers failed');
    await ctx.db.update(releases).set({ bridgeAttemptedAt: new Date() }).where(eq(releases.id, data.releaseId));
    return;
  }

  let discogsReleaseId: number | undefined;
  let discogsMasterId: number | undefined;
  let confidence = 0;
  let source = '';

  try {
    // 4. Case A: MB release (mbid set, no discogs id)
    if (release.mbid && !release.discogsReleaseId) {
      const mbMeta = await mbRelease(ctx, p, release.mbid);
      const artists = mbMeta.artists.join(' ');

      // 4a. MB url-rels
      const urlRels = mbMeta.urlRelations;
      if (urlRels) {
        const rel = discogsIdsFromUrlRelations(urlRels);
        if (rel.releaseId) {
          discogsReleaseId = rel.releaseId;
          confidence = 1;
          source = 'provider_relationship';
        } else if (rel.masterId) {
          discogsMasterId = rel.masterId;
          confidence = 1;
          source = 'provider_relationship';
        }
      }

      // 4b. RG url-rels + Wikidata QID
      if (!discogsReleaseId && rg.mbid) {
        const rgUrlRels = await cached(ctx.sql, 'musicbrainz', cacheKey('rg-urls', rg.mbid), TTLs.mbRelease,
          () => mbCall(ctx, () => p.mb.getReleaseGroupUrlRelations(rg.mbid!, bg)));

        const rel = discogsIdsFromUrlRelations(rgUrlRels);
        if (rel.masterId) {
          discogsMasterId = rel.masterId;
          confidence = 1;
          source = 'provider_relationship';
        }

        // Write wikidata QID as external_ids if found
        const wikiQid = wikidataQidFromUrlRelations(rgUrlRels);
        if (wikiQid) {
          await ctx.sql`
            insert into external_ids (provider, external_id, entity_type, entity_id, url, confidence, source)
            values ('wikidata', ${wikiQid}, 'release_group', ${rg.id}, ${'https://www.wikidata.org/wiki/' + wikiQid}, '1.0000', 'provider_relationship')
            on conflict do nothing
          `;
        }
      }

      // 4c. Wikidata (only if we don't have master from b)
      if (!discogsReleaseId && !discogsMasterId && rg.mbid) {
        const wdResult = await cached(ctx.sql, 'wikidata', cacheKey('rg', rg.mbid), TTLs.wikidata,
          () => wikidataCall(ctx, () => p.wikidata.findByMbReleaseGroup(rg.mbid!)));

        if (wdResult) {
          if (wdResult.discogsMasterId) {
            discogsMasterId = wdResult.discogsMasterId;
            confidence = 0.9;
            source = 'wikidata';
          }
          // Write wikidata external_ids row
          await ctx.sql`
            insert into external_ids (provider, external_id, entity_type, entity_id, url, confidence, source)
            values ('wikidata', ${wdResult.qid}, 'release_group', ${rg.id}, ${'https://www.wikidata.org/wiki/' + wdResult.qid}, '1.0000', 'wikidata')
            on conflict do nothing
          `;
        }
      }

      // 4d. Barcode search
      if (!discogsReleaseId && mbMeta.barcode) {
        const candidates = await discogsSearch(ctx, p, { albumTitle: '', barcode: mbMeta.barcode });
        const hits = candidates.map(c => c.release);
        const hit = pickBarcodeHit(hits, mbMeta.barcode);
        if (hit) {
          const full = await discogsRelease(ctx, p, hit.id!);
          if (full && full.id) {
            discogsReleaseId = Number(full.id);
            discogsMasterId = full.discogsMasterId ? Number(full.discogsMasterId) : undefined;
            confidence = 0.95;
            source = 'barcode';
          }
        }
      }

      // 4e. Catalog number search
      if (!discogsReleaseId && mbMeta.catalogNumber) {
        const candidates = await discogsSearch(ctx, p, { albumTitle: '', catalogNumber: mbMeta.catalogNumber });
        const hits = candidates.map(c => c.release);
        const mbMetaForCatno: { title: string; artists: string[]; year?: number } = {
          title: mbMeta.title,
          artists: [artists],
          ...(mbMeta.year !== undefined ? { year: mbMeta.year } : {}),
        };
        const hit = pickCatnoHit(hits, mbMeta.catalogNumber, mbMetaForCatno);
        if (hit) {
          const full = await discogsRelease(ctx, p, hit.id!);
          if (full && full.id) {
            discogsReleaseId = Number(full.id);
            discogsMasterId = full.discogsMasterId ? Number(full.discogsMasterId) : undefined;
            confidence = 0.9;
            source = 'catno';
          }
        }
      }

      // 4f. Fuzzy search
      if (!discogsReleaseId) {
        const query: any = {
          albumTitle: mbMeta.title,
          artistName: artists,
        };
        if (mbMeta.year !== undefined) query.year = mbMeta.year;
        const candidates = await discogsSearch(ctx, p, query);
        const hits = candidates.map(c => c.release);
        const mbMetaForFuzzy: { title: string; artists: string[]; year?: number } = {
          title: mbMeta.title,
          artists: [artists],
          ...(mbMeta.year !== undefined ? { year: mbMeta.year } : {}),
        };
        const fuzzyHit = pickFuzzyHit(hits, mbMetaForFuzzy, discogsMasterId);

        if (fuzzyHit) {
          const full = await discogsRelease(ctx, p, fuzzyHit.hit.id!);
          if (full && full.id) {
            discogsReleaseId = Number(full.id);
            discogsMasterId = full.discogsMasterId ? Number(full.discogsMasterId) : undefined;
            confidence = fuzzyHit.score;
            source = 'fuzzy';
          }
        }
      }

      // When release found, persist sidecars
      if (discogsReleaseId) {
        const dgRel = await discogsRelease(ctx, p, discogsReleaseId);
        const primary = dgRel.images?.find((i) => i.primary) ?? dgRel.images?.[0];
        await upsertDiscogsSidecars(ctx, {
          releaseId: release.id,
          releaseGroupId: rg.id,
          discogsReleaseId,
          discogsMasterId: discogsMasterId ?? (dgRel.discogsMasterId ? Number(dgRel.discogsMasterId) : undefined),
          ...(dgRel.genres ? { genres: dgRel.genres } : {}),
          ...(dgRel.styles ? { styles: dgRel.styles } : {}),
          ...(primary ? { primaryImage: primary } : {}),
          confidence,
          source,
        });
        if (primary) await enqueueArtForRelease(ctx, release.id);
      } else if (discogsMasterId) {
        // Master without release edition
        const dgMaster = await discogsMaster(ctx, p, discogsMasterId);
        const primary = dgMaster.images?.find((i) => i.primary) ?? dgMaster.images?.[0];
        await upsertDiscogsSidecars(ctx, {
          releaseId: release.id,
          releaseGroupId: rg.id,
          discogsMasterId,
          ...(dgMaster.genres ? { genres: dgMaster.genres } : {}),
          ...(dgMaster.styles ? { styles: dgMaster.styles } : {}),
          ...(primary ? { primaryImage: primary } : {}),
          confidence,
          source,
        });
      }
    } else if (!release.mbid && release.discogsReleaseId) {
      // 5. Case B: Discogs-only release (reverse bridge)
      const discogsUrl = `https://www.discogs.com/release/${release.discogsReleaseId}`;
      const urlLookup = await cached(ctx.sql, 'musicbrainz', cacheKey('url', discogsUrl), TTLs.mbUrl,
        () => mbCall(ctx, () => p.mb.lookupUrl(discogsUrl, bg)));

      if (urlLookup.releaseMbids.length === 0) {
        // No MB release found; mark attempted and done
        await ctx.db.update(releases).set({ bridgeAttemptedAt: new Date() }).where(eq(releases.id, data.releaseId));
        return;
      }

      // Take the first MBID
      const mbid = urlLookup.releaseMbids[0]!;
      const mbRel = await mbRelease(ctx, p, mbid);

      // Persist the MB release + relink
      const newIds = await persistFetched(ctx, mbRel);

      // RELINK in ONE transaction
      await ctx.sql.begin(async (tx) => {
        // Update release.discogs_release_id = null for old
        await tx`update releases set discogs_release_id = null where id = ${release.id}`;

        // Set on new (if not already claimed)
        await tx`update releases set discogs_release_id = ${release.discogsReleaseId} where id = ${newIds.releaseId} and discogs_release_id is null`;

        // Update local_albums
        await tx`update local_albums set release_id = ${newIds.releaseId}, release_group_id = ${newIds.releaseGroupId} where release_id = ${release.id}`;

        // Update album_matches
        await tx`update album_matches set release_id = ${newIds.releaseId} where release_id = ${release.id}`;

        // Update match_candidates
        await tx`update match_candidates set release_id = ${newIds.releaseId} where release_id = ${release.id}`;

        // Move external_ids: insert...select...on conflict do nothing, then delete old
        await tx`insert into external_ids (provider, external_id, entity_type, entity_id, url, confidence, source)
          select provider, external_id, entity_type, ${newIds.releaseId}::uuid, url, confidence, source
          from external_ids where entity_type = 'release' and entity_id = ${release.id}
          on conflict do nothing`;
        await tx`delete from external_ids where entity_type = 'release' and entity_id = ${release.id}`;

        // Move entity_tags for release
        await tx`insert into entity_tags (entity_type, entity_id, tag, kind, source, weight)
          select entity_type, ${newIds.releaseId}::uuid, tag, kind, source, weight
          from entity_tags where entity_type = 'release' and entity_id = ${release.id}
          on conflict do nothing`;
        await tx`delete from entity_tags where entity_type = 'release' and entity_id = ${release.id}`;

        // Move entity_tags for old RG (if retiring it)
        if (release.releaseGroupId !== newIds.releaseGroupId) {
          await tx`insert into entity_tags (entity_type, entity_id, tag, kind, source, weight)
            select entity_type, ${newIds.releaseGroupId}::uuid, tag, kind, source, weight
            from entity_tags where entity_type = 'release_group' and entity_id = ${release.releaseGroupId}
            on conflict do nothing`;
          await tx`delete from entity_tags where entity_type = 'release_group' and entity_id = ${release.releaseGroupId}`;
        }

        // Move image_sources
        await tx`insert into image_sources (entity_type, entity_id, kind, provider, source_url, width, height, license_note, fetched_at)
          select entity_type, ${newIds.releaseId}::uuid, kind, provider, source_url, width, height, license_note, fetched_at
          from image_sources where entity_type = 'release' and entity_id = ${release.id}
          on conflict do nothing`;
        await tx`delete from image_sources where entity_type = 'release' and entity_id = ${release.id}`;

        // Delete old release
        await tx`delete from releases where id = ${release.id}`;

        // Delete old RG if no releases left
        if (release.releaseGroupId !== newIds.releaseGroupId) {
          const relCount = await tx`select count(*) as cnt from releases where release_group_id = ${release.releaseGroupId}`;
          if (Number((relCount as unknown as Array<{ cnt: string | number }>)[0]?.cnt ?? 0) === 0) {
            await tx`delete from release_groups where id = ${release.releaseGroupId}`;
          }
        }
      });

      // After transaction: upsert Discogs sidecars on NEW ids
      const dgRel = await discogsRelease(ctx, p, release.discogsReleaseId);
      const primary = dgRel.images?.find((i) => i.primary) ?? dgRel.images?.[0];
      await upsertDiscogsSidecars(ctx, {
        releaseId: newIds.releaseId,
        releaseGroupId: newIds.releaseGroupId,
        discogsReleaseId: release.discogsReleaseId,
        discogsMasterId: dgRel.discogsMasterId ? Number(dgRel.discogsMasterId) : undefined,
        ...(dgRel.genres ? { genres: dgRel.genres } : {}),
        ...(dgRel.styles ? { styles: dgRel.styles } : {}),
        ...(primary ? { primaryImage: primary } : {}),
        confidence: 1,
        source: 'provider_relationship',
      });

      ctx.logger.info({
        releaseId: data.releaseId,
        mbid,
        newReleaseId: newIds.releaseId,
      }, 'enrich: discogs-only → mb reverse bridge');

      // 6. Art follow-up
      await enqueueArtForRelease(ctx, newIds.releaseId);

      return;
    }
  } catch (err) {
    // Let rate limit errors propagate for retries; log others
    const msg = err instanceof Error ? err.message : String(err);
    if (/\b(503|429)\b|rate limit/i.test(msg)) {
      throw err;
    }
    ctx.logger.warn({ releaseId: data.releaseId, err }, 'enrich: provider call failed');
  }

  // 7. Always finish by stamping bridge_attempted_at
  await ctx.db.update(releases).set({ bridgeAttemptedAt: new Date() }).where(eq(releases.id, data.releaseId));

  if (discogsReleaseId || discogsMasterId) {
    ctx.logger.info({
      releaseId: data.releaseId,
      method: source,
      confidence,
      discogsReleaseId,
      discogsMasterId,
    }, 'enrich: release enriched');
  }
}

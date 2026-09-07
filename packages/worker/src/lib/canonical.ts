/**
 * Canonical data upsert logic for MusicBrainz and Discogs releases.
 * Spec §11, ENR-1.
 */
import { eq, sql } from 'drizzle-orm';
import {
  releaseGroups, releases, canonicalTracks, externalIds, entityTags, imageSources, artists, releaseGroupArtists,
} from '@liner/db';
import type { CanonicalRelease, CanonicalTrack, ArtistCredit } from '@liner/core';
import type { WorkerContext } from './context.js';

/**
 * Extract artist links from credits, keeping only those with mbid.
 * Returns an array of artist link records for upsert.
 */
/** First occurrence per mbid, order preserved (multi-row upserts need distinct conflict keys). */
export function uniqueByMbid<T extends { mbid: string }>(links: T[]): T[] {
  const seen = new Set<string>();
  return links.filter((l) => (seen.has(l.mbid) ? false : (seen.add(l.mbid), true)));
}

export function artistLinksFrom(
  credits: ArtistCredit[] | undefined,
): Array<{ mbid: string; name: string; position: number; creditedName: string | undefined; joinPhrase: string | undefined }> {
  if (!credits || credits.length === 0) return [];

  return credits
    .map((credit, position) => ({
      mbid: credit.mbid,
      name: credit.name.trim(),
      position,
      creditedName: credit.name.trim(),
      joinPhrase: credit.joinPhrase,
    }))
    .filter(link => link.mbid !== undefined) as Array<{ mbid: string; name: string; position: number; creditedName: string | undefined; joinPhrase: string | undefined }>;
}

/**
 * Normalize partial dates (YYYY, YYYY-MM, YYYY-MM-DD) to full dates.
 */
export function normDate(d: string | undefined): string | null {
  if (!d) return null;
  if (/^\d{4}$/.test(d)) return `${d}-01-01`;
  if (/^\d{4}-\d{2}$/.test(d)) return `${d}-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  return null;
}

/**
 * Build labels jsonb array from CanonicalRelease.labels.
 */
export function buildLabelsJsonb(
  labels?: Array<{ name: string; catalogNumber?: string | undefined }>,
  fallback?: string,
): unknown {
  if (labels && labels.length > 0) {
    return labels.map(l => l.catalogNumber ? { name: l.name, catalogNumber: l.catalogNumber } : { name: l.name });
  }
  if (fallback) return [{ name: fallback }];
  return [];
}

/**
 * Build media jsonb array from CanonicalRelease.mediaList.
 */
export function buildMediaJsonb(
  mediaList?: Array<{ position: number; format: string; trackCount: number }>,
  fallback?: string,
): Array<{ position: number; format: string; trackCount?: number }> {
  if (mediaList && mediaList.length > 0) {
    return mediaList.map((m) => ({
      position: m.position,
      format: m.format,
      ...(m.trackCount ? { trackCount: m.trackCount } : {}),
    }));
  }
  if (fallback) return [{ position: 1, format: fallback }];
  return [];
}

/**
 * Upsert canonical release (MusicBrainz or Discogs).
 * Returns { releaseId, releaseGroupId } as DB UUIDs.
 */
export async function upsertCanonical(
  ctx: WorkerContext,
  release: CanonicalRelease,
): Promise<{ releaseId: string; releaseGroupId: string }> {
  // Determine RG identity and upsert
  let rgInsert: { id: string };

  if (release.source === 'musicbrainz') {
    // MB: by mbid
    // Release-group type drives the artist page's discography sections
    // (BRW-3); only MusicBrainz knows it, so never null an existing value.
    const typeCols = {
      ...(release.primaryType ? { primaryType: release.primaryType } : {}),
      ...(release.secondaryTypes?.length ? { secondaryTypes: release.secondaryTypes } : {}),
    };
    rgInsert = (await ctx.db.insert(releaseGroups)
      .values({
        mbid: release.releaseGroupId,
        title: release.title,
        artistCredit: release.artists,
        ...typeCols,
        fetchedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: releaseGroups.mbid,
        set: { fetchedAt: new Date(), ...typeCols },
      })
      .returning({ id: releaseGroups.id }))[0]!;
  } else {
    // Discogs: by discogs_master_id (if present) or synthetic discogs_release_id
    if (release.discogsMasterId) {
      const normalized = normDate(release.date);
      rgInsert = (await ctx.db.insert(releaseGroups)
        .values({
          discogsmasterId: parseInt(release.discogsMasterId, 10),
          title: release.title,
            artistCredit: release.artists,
          ...(normalized ? { firstReleaseDate: normalized } : {}),
          fetchedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: releaseGroups.discogsmasterId,
          set: { fetchedAt: new Date() },
        })
        .returning({ id: releaseGroups.id }))[0]!;
    } else {
      // Synthetic RG for Discogs-only (no master)
      const normalized = normDate(release.date);
      rgInsert = (await ctx.db.insert(releaseGroups)
        .values({
          discogsReleaseId: parseInt(release.id, 10),
          title: release.title,
            artistCredit: release.artists,
          ...(normalized ? { firstReleaseDate: normalized } : {}),
          fetchedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: releaseGroups.discogsReleaseId,
          set: { fetchedAt: new Date() },
        })
        .returning({ id: releaseGroups.id }))[0]!;
    }
  }

  const rgId = rgInsert.id;

  // Upsert artists and release_group_artists from artistCredits with mbid
  if (release.artistCredits && release.artistCredits.length > 0) {
    const artistLinks = artistLinksFrom(release.artistCredits);

    if (artistLinks.length > 0) {
      // One statement per table: postgres.js sends JS arrays as PG arrays,
      // so unnest() turns the credit list into rows (no per-artist round trips).
      const mbids = artistLinks.map((l) => l.mbid);
      const positions = artistLinks.map((l) => l.position);
      const credited = artistLinks.map((l) => l.creditedName ?? null);
      const joins = artistLinks.map((l) => l.joinPhrase ?? null);
      // A credit list can name the same artist twice (composer + performer on
      // soundtracks); a multi-row upsert must see each mbid once or Postgres
      // refuses ("ON CONFLICT DO UPDATE command cannot affect row a second time").
      const uniqueArtists = uniqueByMbid(artistLinks);
      // Upsert artists by mbid; never overwrite a name enrichment already filled.
      await ctx.sql`
        insert into artists (mbid, name)
        select c.mbid, c.name from unnest(${uniqueArtists.map((l) => l.mbid)}::text[], ${uniqueArtists.map((l) => l.name)}::text[]) as c(mbid, name)
        on conflict (mbid) do update
          set name = case when artists.name = '' or artists.name is null then excluded.name else artists.name end`;
      await ctx.db.delete(releaseGroupArtists).where(eq(releaseGroupArtists.releaseGroupId, rgId));
      await ctx.sql`
        insert into release_group_artists (release_group_id, artist_id, position, credited_name, join_phrase)
        select ${rgId}::uuid, a.id, c.position, c.credited_name, c.join_phrase
          from unnest(${mbids}::text[], ${positions}::int[], ${credited}::text[], ${joins}::text[])
               as c(mbid, position, credited_name, join_phrase)
          join artists a on a.mbid = c.mbid
        on conflict do nothing`;

      // Set artists_resolved_at
      await ctx.db.update(releaseGroups)
        .set({ artistsResolvedAt: new Date() })
        .where(eq(releaseGroups.id, rgId));
    }
  }

  // Upsert MB genres and tags into entity_tags
  if (release.mbGenres && release.mbGenres.length > 0) {
    for (const genre of release.mbGenres) {
      await ctx.sql`
        insert into entity_tags (entity_type, entity_id, tag, kind, source, weight)
        values (
          'release_group',
          ${rgId}::uuid,
          ${genre.name.trim()},
          'genre',
          'musicbrainz',
          ${genre.count ?? 0}
        )
        on conflict (entity_type, entity_id, kind, source, lower(tag))
        do update set weight = excluded.weight
      `;
    }
  }

  if (release.mbTags && release.mbTags.length > 0) {
    for (const tag of release.mbTags) {
      await ctx.sql`
        insert into entity_tags (entity_type, entity_id, tag, kind, source, weight)
        values (
          'release_group',
          ${rgId}::uuid,
          ${tag.name.trim()},
          'tag',
          'musicbrainz',
          ${tag.count ?? 0}
        )
        on conflict (entity_type, entity_id, kind, source, lower(tag))
        do update set weight = excluded.weight
      `;
    }
  }

  // Upsert release
  const dateStr = normDate(release.date) ?? (release.year ? `${release.year}-01-01` : null);
  const relInsert = (await ctx.db.insert(releases)
    .values({
      releaseGroupId: rgId,
      ...(release.source === 'musicbrainz' ? { mbid: release.id } : {}),
      ...(release.source === 'discogs' ? { discogsReleaseId: parseInt(release.id, 10) } : {}),
      title: release.title,
      ...(release.status ? { status: release.status } : {}),
      ...(dateStr ? { date: dateStr } : {}),
      ...(release.country && release.country.length === 2 ? { country: release.country } : {}),
      ...(release.barcode ? { barcode: release.barcode } : {}),
      labels: buildLabelsJsonb(release.labels, release.label) as any,
      media: buildMediaJsonb(release.mediaList, release.media) as any,
      ...(release.tracks?.length ? { trackCount: release.tracks.length } : {}),
      sourceOfTruth: release.source === 'musicbrainz' ? ('musicbrainz' as const) : ('discogs' as const),
      fetchedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: release.source === 'musicbrainz' ? releases.mbid : releases.discogsReleaseId,
      set: { fetchedAt: new Date() },
    })
    .returning({ id: releases.id }))[0]!;

  const relId = relInsert.id;

  // Upsert canonical tracks
  if (release.tracks && release.tracks.length > 0) {
    await ctx.db.delete(canonicalTracks).where(eq(canonicalTracks.releaseId, relId));
    await ctx.db.insert(canonicalTracks).values(
      release.tracks.map((t: CanonicalTrack) => ({
        releaseId: relId,
        mediumNo: t.mediumNumber,
        position: t.position,
        title: t.title.slice(0, 255),
        artistCredit: t.artists,
        recordingId: null,
        lengthMs: Math.round(t.duration ?? 0),
        isDataTrack: t.isDataTrack ?? false,
        isVideo: t.isVideoTrack ?? false,
      })),
    );
  }

  return { releaseId: relId, releaseGroupId: rgId };
}

/**
 * Upsert Discogs sidecar data (external IDs, tags, images).
 * Only call after upsertCanonical has been done (IDs must exist).
 */
export interface DiscogsSidecarInput {
  releaseId: string; // DB UUID
  releaseGroupId: string; // DB UUID
  discogsReleaseId?: number | undefined;
  discogsMasterId?: number | undefined;
  genres?: string[] | undefined;
  styles?: string[] | undefined;
  primaryImage?: { url: string; width?: number | undefined; height?: number | undefined } | undefined;
  confidence: number; // 0..1
  source: string; // e.g., 'mb_relation', 'wikidata', 'barcode', 'catno', 'fuzzy'
}

export async function upsertDiscogsSidecars(
  ctx: WorkerContext,
  input: DiscogsSidecarInput,
): Promise<void> {
  // Insert external_ids for release ↔ discogs release
  if (input.discogsReleaseId) {
    try {
      await ctx.db.insert(externalIds).values({
        provider: 'discogs',
        externalId: String(input.discogsReleaseId),
        entityType: 'release',
        entityId: input.releaseId,
        url: `https://www.discogs.com/release/${input.discogsReleaseId}`,
        confidence: String(input.confidence),
        source: input.source,
      })
        .onConflictDoUpdate({
          target: [
            externalIds.provider,
            externalIds.externalId,
            externalIds.entityType,
            externalIds.entityId,
          ],
          set: {
            confidence: sql`greatest(coalesce(${externalIds.confidence}, 0), excluded.confidence)`,
            source: sql`case when excluded.confidence >= coalesce(${externalIds.confidence}, 0) then excluded.source else ${externalIds.source} end`,
            url: sql`case when excluded.confidence >= coalesce(${externalIds.confidence}, 0) then excluded.url else ${externalIds.url} end`,
          },
        });
    } catch (err) {
      // UNIQUE violation (another release already has this discogs id): log and continue
      if ((err as any).code === '23505') {
        ctx.logger.warn(
          { discogsReleaseId: input.discogsReleaseId, releaseId: input.releaseId },
          'discogs release id conflict with another release',
        );
      } else {
        throw err;
      }
    }
  }

  // Insert external_ids for release_group ↔ discogs master
  if (input.discogsMasterId) {
    try {
      await ctx.db.insert(externalIds).values({
        provider: 'discogs',
        externalId: String(input.discogsMasterId),
        entityType: 'release_group',
        entityId: input.releaseGroupId,
        url: `https://www.discogs.com/master/${input.discogsMasterId}`,
        confidence: String(input.confidence),
        source: input.source,
      })
        .onConflictDoUpdate({
          target: [
            externalIds.provider,
            externalIds.externalId,
            externalIds.entityType,
            externalIds.entityId,
          ],
          set: {
            confidence: sql`greatest(coalesce(${externalIds.confidence}, 0), excluded.confidence)`,
            source: sql`case when excluded.confidence >= coalesce(${externalIds.confidence}, 0) then excluded.source else ${externalIds.source} end`,
            url: sql`case when excluded.confidence >= coalesce(${externalIds.confidence}, 0) then excluded.url else ${externalIds.url} end`,
          },
        });
    } catch (err) {
      if ((err as any).code === '23505') {
        ctx.logger.warn(
          { discogsMasterId: input.discogsMasterId, releaseGroupId: input.releaseGroupId },
          'discogs master id conflict with another release group',
        );
      } else {
        throw err;
      }
    }
  }

  // Canonical id columns: first row to claim an id keeps it (UNIQUE); a
  // second MB edition bridging to the same Discogs release keeps only the
  // external_ids link (many-to-one is real, spec §11.2).
  if (input.discogsReleaseId) {
    try {
      await ctx.sql`update releases set discogs_release_id = ${input.discogsReleaseId}
        where id = ${input.releaseId} and discogs_release_id is null`;
    } catch (err) {
      if ((err as { code?: string }).code !== '23505') throw err;
      ctx.logger.info({ discogsReleaseId: input.discogsReleaseId, releaseId: input.releaseId }, 'discogs release id already owned by another release');
    }
  }
  if (input.discogsMasterId) {
    try {
      await ctx.sql`update release_groups set discogs_master_id = ${input.discogsMasterId}
        where id = ${input.releaseGroupId} and discogs_master_id is null`;
    } catch (err) {
      if ((err as { code?: string }).code !== '23505') throw err;
      ctx.logger.info({ discogsMasterId: input.discogsMasterId, releaseGroupId: input.releaseGroupId }, 'discogs master id already owned by another release group');
    }
  }

  // Entity tags: genres and styles
  const tagsToInsert = [];
  if (input.genres) {
    for (const genre of input.genres) {
      tagsToInsert.push({
        entityType: 'release_group',
        entityId: input.releaseGroupId,
        tag: genre,
        kind: 'genre',
        source: 'discogs',
      });
    }
  }
  if (input.styles) {
    for (const style of input.styles) {
      tagsToInsert.push({
        entityType: 'release_group',
        entityId: input.releaseGroupId,
        tag: style,
        kind: 'style',
        source: 'discogs',
      });
    }
  }

  if (tagsToInsert.length > 0) {
    await ctx.db.insert(entityTags).values(tagsToInsert as any)
      .onConflictDoNothing();
  }

  // Image source: front image (if present)
  if (input.primaryImage) {
    await ctx.db.insert(imageSources).values({
      entityType: 'release',
      entityId: input.releaseId,
      kind: 'front',
      provider: 'discogs',
      sourceUrl: input.primaryImage.url,
      ...(input.primaryImage.width ? { width: input.primaryImage.width } : {}),
      ...(input.primaryImage.height ? { height: input.primaryImage.height } : {}),
      licenseNote: 'Discogs user-posted image (Restricted Data): cached for display in this library only; not redistributed',
      fetchedAt: new Date(),
    })
      .onConflictDoUpdate({
        target: [
          imageSources.entityType,
          imageSources.entityId,
          imageSources.provider,
          imageSources.kind,
        ],
        set: {
          sourceUrl: input.primaryImage.url,
          ...(input.primaryImage.width ? { width: input.primaryImage.width } : {}),
          ...(input.primaryImage.height ? { height: input.primaryImage.height } : {}),
          fetchedAt: new Date(),
        },
      });
  }
}

/**
 * Resolved metadata service: loads canonical data and field locks from the database,
 * then calls the pure resolveFields function to produce resolved metadata for a file.
 *
 * This is the single authoritative source for canonical fields per file,
 * accounting for active locks (ENR-5). Both tag plan preview and apply consume this.
 *
 * Spec: §11.5 (line 547), XO-353.
 */

import { eq, and, sql } from 'drizzle-orm';
import {
  releases,
  releaseGroups,
  canonicalTracks,
  fieldLocks,
  entityTags,
} from '@liner/db';
import type { WorkerContext } from './context.js';
import {
  resolveFields,
  type ResolvedMetadata,
  type ResolutionInput,
} from '@liner/core';
import { effectiveGenres, normalizeGenreMap, DEFAULT_GENRE_MAP } from '@liner/core';

/**
 * Load and resolve canonical metadata for a file.
 *
 * Given a library, audio file, and matched release ID, loads all canonical data
 * (release, release group, track, artist credits, effective genres) and active field locks,
 * then calls resolveFields to produce resolved metadata.
 *
 * @param ctx Worker context with database connection
 * @param libraryId Library UUID
 * @param audioFileId Audio file UUID
 * @param releaseId Matched release UUID
 * @returns ResolvedMetadata with all 32 canonical fields
 * @throws If release not found
 */
export async function resolveMetadata(
  ctx: WorkerContext,
  libraryId: string,
  audioFileId: string,
  releaseId: string,
): Promise<ResolvedMetadata> {
  // Load release and release group separately
  const releaseRow = await ctx.db.query.releases.findFirst({
    where: eq(releases.id, releaseId),
  });

  if (!releaseRow) {
    throw new Error(`Release not found: ${releaseId}`);
  }

  const releaseGroup = await ctx.db.query.releaseGroups.findFirst({
    where: eq(releaseGroups.id, releaseRow.releaseGroupId),
  });

  if (!releaseGroup) {
    throw new Error(`Release group not found: ${releaseRow.releaseGroupId}`);
  }

  // Load the matched canonical track from the release
  let canonicalTrack: any = null;
  const tracks = await ctx.db.query.canonicalTracks.findMany({
    where: eq(canonicalTracks.releaseId, releaseId),
  });
  if (tracks.length > 0) {
    canonicalTrack = tracks[0];
  }

  // Load release group artist credits from the releaseGroup.artistCredit JSONB field
  // Or load individual artist links if needed (simpler: just use what's in the release group)
  const rgArtistCredit = (releaseGroup.artistCredit as any[]) || [];
  const rgArtistCredits: Array<{ name: string; joinPhrase?: string; mbid?: string }> = rgArtistCredit.map((credit: any) => ({
    name: credit.name || '',
    ...(credit.joinPhrase ? { joinPhrase: credit.joinPhrase } : {}),
    ...(credit.mbid ? { mbid: credit.mbid } : {}),
  }));

  // Load effective genres from entity_tags (Discogs + MusicBrainz)
  // Note: We query by releaseGroupId since tags are stored at the release group level
  const rawTagsRows = await ctx.db.execute(sql`
    select tag, kind, source, weight from entity_tags where release_group_id = ${releaseGroup.id}
  `);
  const rawTags = (rawTagsRows as any[]) || [];

  const rawTagsForGenres = rawTags.map((t) => ({
    tag: t.tag,
    kind: t.kind as 'genre' | 'style' | 'tag',
    source: t.source as 'discogs' | 'musicbrainz',
    weight: t.weight ? parseInt(t.weight.toString(), 10) : null,
  }));

  const genres = effectiveGenres(rawTagsForGenres, DEFAULT_GENRE_MAP);

  // Load field locks for this file (scope=file or scope=album)
  const fileLocks = await ctx.db.query.fieldLocks.findMany({
    where: and(
      eq(fieldLocks.libraryId, libraryId as any),
      eq(fieldLocks.scope, 'file'),
      eq(fieldLocks.scopeId, audioFileId as any),
    ),
  });

  const locks: Parameters<typeof resolveFields>[0]['locks'] = fileLocks.map((lock) => ({
    field: lock.field,
    value: (lock.value as any),
    scope: 'file' as const,
    createdAt: lock.createdAt,
    reason: lock.reason,
  }));

  // TODO: Load album-level locks when localAlbumId is available
  // This requires joining with localTracks and localAlbums

  // Format release data
  const releaseLabels = (releaseRow.labels as any[] | null) || [];
  const releaseMedia = (releaseRow.media as any[] | null) || [];
  const trackArtistCredit = (canonicalTrack?.artistCredit as any[] | null) || [];

  // Helper to format dates from Date or string
  function formatDate(d: Date | string | null): string | undefined {
    if (!d) return undefined;
    if (typeof d === 'string') return d;
    const iso = d.toISOString();
    return iso.split('T')[0];
  }

  // Build resolution input
  const input: ResolutionInput = {
    release: {
      title: releaseRow.title,
      ...(formatDate(releaseRow.date) ? { date: formatDate(releaseRow.date)! } : {}),
      ...(releaseRow.country ? { country: releaseRow.country } : {}),
      ...(releaseRow.barcode ? { barcode: releaseRow.barcode } : {}),
      ...(releaseRow.status ? { status: releaseRow.status } : {}),
      ...(releaseRow.trackCount ? { trackCount: releaseRow.trackCount } : {}),
      labels: releaseLabels,
      media: releaseMedia,
      ...(releaseRow.mbid ? { mbid: releaseRow.mbid } : {}),
      ...(releaseRow.discogsReleaseId ? { discogsReleaseId: releaseRow.discogsReleaseId } : {}),
      artists: rgArtistCredits,
    },
    releaseGroup: {
      title: releaseGroup.title,
      ...(releaseGroup.primaryType ? { primaryType: releaseGroup.primaryType } : {}),
      ...(formatDate(releaseGroup.firstReleaseDate) ? { firstReleaseDate: formatDate(releaseGroup.firstReleaseDate)! } : {}),
      ...(releaseGroup.mbid ? { mbid: releaseGroup.mbid } : {}),
      ...(releaseGroup.discogsmasterId ? { discogsMasterId: releaseGroup.discogsmasterId } : {}),
      secondaryTypes: (releaseGroup.secondaryTypes as string[] | null) || [],
      artistCredit: rgArtistCredits,
    },
    ...(canonicalTrack
      ? {
          track: {
            ...(canonicalTrack.title ? { title: canonicalTrack.title } : {}),
            ...(canonicalTrack.number ? { number: canonicalTrack.number } : {}),
            ...(canonicalTrack.position !== null && canonicalTrack.position !== undefined ? { position: canonicalTrack.position } : {}),
            ...(canonicalTrack.mediumNo ? { mediumNo: canonicalTrack.mediumNo } : {}),
            ...(canonicalTrack.recordingId ? { mbid: canonicalTrack.recordingId } : {}),
            artistCredit: trackArtistCredit,
          },
        }
      : {}),
    artistCredits: rgArtistCredits,
    effectiveGenres: genres,
    locks,
  };

  return resolveFields(input as ResolutionInput);
}

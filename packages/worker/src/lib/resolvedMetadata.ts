/**
 * Resolved metadata service: loads canonical data and field locks from the
 * database, then calls the pure resolveFields function to produce resolved
 * metadata for a file.
 *
 * This is the single authoritative source for canonical fields per file,
 * accounting for active locks (ENR-5). Both tag plan preview and apply consume
 * it. Spec: §11.5 (line 547), XO-353.
 */

import { and, eq, inArray } from 'drizzle-orm';
import {
  audioFiles,
  canonicalTracks,
  fieldLocks,
  libraries,
  localAlbums,
  localTracks,
  releaseGroups,
  releases,
} from '@liner/db';
import type { WorkerContext } from './context.js';
import {
  resolveFields,
  effectiveGenres,
  normalizeGenreMap,
  type ResolvedMetadata,
  type ResolutionInput,
} from '@liner/core';

type Credit = { name: string; joinPhrase?: string; mbid?: string };

function creditsOf(raw: unknown): Credit[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c: unknown) => {
      if (typeof c === 'string') return { name: c };
      const o = (c ?? {}) as { name?: unknown; joinPhrase?: unknown; mbid?: unknown };
      return {
        name: typeof o.name === 'string' ? o.name : '',
        ...(typeof o.joinPhrase === 'string' ? { joinPhrase: o.joinPhrase } : {}),
        ...(typeof o.mbid === 'string' ? { mbid: o.mbid } : {}),
      };
    })
    .filter((c) => c.name);
}

/** Dates arrive as Date (drizzle `date` columns in some drivers) or 'YYYY-MM-DD'. */
function formatDate(d: Date | string | null | undefined): string | undefined {
  if (!d) return undefined;
  if (typeof d === 'string') return d;
  return d.toISOString().split('T')[0];
}

export interface FileResolution {
  resolved: ResolvedMetadata;
  releaseId: string;
  localAlbumId: string;
  /** canonical_tracks row matched by position, when one was found */
  canonicalTrackId: string | null;
}

export type FileResolutionResult =
  | { ok: true; value: FileResolution }
  | { ok: false; reason: 'not_in_album' | 'album_not_identified' | 'release_missing' };

/**
 * Canonical fields for one audio file: its album's matched release, the
 * canonical track at the same (disc, track) position, the release group's
 * effective genres through the library's genre map, and active file- and
 * album-level locks. Files whose album is not identified resolve to nothing —
 * there is no canonical truth to write.
 */
export async function resolveMetadataForFile(
  ctx: WorkerContext,
  libraryId: string,
  audioFileId: string,
): Promise<FileResolutionResult> {
  const [track] = await ctx.db
    .select({
      id: localTracks.id,
      localAlbumId: localTracks.localAlbumId,
      discNo: localTracks.discNo,
      trackNo: localTracks.trackNo,
      origin: localTracks.origin,
    })
    .from(localTracks)
    .where(eq(localTracks.audioFileId, audioFileId))
    .orderBy(localTracks.origin) // 'cue' < 'file': a cue-split image keeps its per-track rows first
    .limit(1);
  if (!track || !track.localAlbumId) return { ok: false, reason: 'not_in_album' };

  const [album] = await ctx.db
    .select({ id: localAlbums.id, releaseId: localAlbums.releaseId, state: localAlbums.state, discCount: localAlbums.discCount })
    .from(localAlbums)
    .where(and(eq(localAlbums.id, track.localAlbumId), eq(localAlbums.libraryId, libraryId)));
  if (!album || !album.releaseId || album.state !== 'matched') return { ok: false, reason: 'album_not_identified' };

  const [releaseRow] = await ctx.db.select().from(releases).where(eq(releases.id, album.releaseId));
  if (!releaseRow) return { ok: false, reason: 'release_missing' };
  const [releaseGroup] = await ctx.db.select().from(releaseGroups).where(eq(releaseGroups.id, releaseRow.releaseGroupId));
  if (!releaseGroup) return { ok: false, reason: 'release_missing' };

  // The matched canonical track: same medium + position as the local track
  // (disc 1 when the file carries no disc number), else the same ordinal when
  // the counts line up. identify does not persist per-track alignment yet.
  const tracks = await ctx.db
    .select()
    .from(canonicalTracks)
    .where(eq(canonicalTracks.releaseId, album.releaseId));
  const byPos = new Map(tracks.map((t) => [`${t.mediumNo ?? 1}:${t.position ?? 0}`, t]));
  let canonicalTrack = track.trackNo ? byPos.get(`${track.discNo ?? 1}:${track.trackNo}`) ?? null : null;
  if (!canonicalTrack && track.trackNo && (album.discCount ?? 1) === 1) {
    const ordered = [...tracks].sort((a, b) => (a.mediumNo ?? 1) - (b.mediumNo ?? 1) || (a.position ?? 0) - (b.position ?? 0));
    const albumTracks = await ctx.db
      .select({ audioFileId: localTracks.audioFileId, discNo: localTracks.discNo, trackNo: localTracks.trackNo })
      .from(localTracks)
      .where(eq(localTracks.localAlbumId, album.id));
    if (albumTracks.length === ordered.length) {
      const mine = [...albumTracks].sort((a, b) => (a.discNo ?? 1) - (b.discNo ?? 1) || (a.trackNo ?? 0) - (b.trackNo ?? 0));
      const idx = mine.findIndex((t) => t.audioFileId === audioFileId);
      if (idx >= 0) canonicalTrack = ordered[idx] ?? null;
    }
  }

  // Effective genres through the library's map (Settings › Genres).
  const [lib] = await ctx.db.select({ settings: libraries.settings }).from(libraries).where(eq(libraries.id, libraryId));
  const settings = (typeof lib?.settings === 'string' ? JSON.parse(lib.settings) : lib?.settings ?? {}) as Record<string, unknown>;
  const genreMap = normalizeGenreMap((settings['genreMap'] as Parameters<typeof normalizeGenreMap>[0]) ?? null);
  const tagRows = (await ctx.sql`
    select tag, kind, source, weight from entity_tags
     where entity_type = 'release_group' and entity_id = ${releaseGroup.id}`) as unknown as Array<{ tag: string; kind: string; source: string; weight: string | number | null }>;
  const genres = effectiveGenres(
    tagRows.map((t) => ({ tag: t.tag, kind: t.kind as 'genre' | 'style' | 'tag', source: t.source, weight: t.weight === null ? null : Number(t.weight) })),
    genreMap,
  );

  // Locks (ENR-5): field_locks scopes are 'album' (local album id) and
  // 'track' (local track id or audio file id); a track lock wins over an album
  // lock — resolveFields knows them as 'file' and 'album'.
  const lockRows = await ctx.db
    .select()
    .from(fieldLocks)
    .where(and(
      eq(fieldLocks.libraryId, libraryId),
      inArray(fieldLocks.scopeId, [audioFileId, track.id, album.id]),
    ));
  const locks: NonNullable<ResolutionInput['locks']> = lockRows
    .filter((l) => (l.scope === 'track' && (l.scopeId === audioFileId || l.scopeId === track.id)) || (l.scope === 'album' && l.scopeId === album.id))
    .map((l) => ({
      field: l.field,
      value: l.value as string | string[] | undefined,
      scope: l.scope === 'track' ? ('file' as const) : ('album' as const),
      createdAt: l.createdAt,
      reason: l.reason,
    }));

  const albumCredits = creditsOf(releaseGroup.artistCredit);
  const input: ResolutionInput = {
    release: {
      title: releaseRow.title,
      ...(formatDate(releaseRow.date) ? { date: formatDate(releaseRow.date)! } : {}),
      ...(releaseRow.country ? { country: releaseRow.country } : {}),
      ...(releaseRow.barcode ? { barcode: releaseRow.barcode } : {}),
      ...(releaseRow.status ? { status: releaseRow.status } : {}),
      ...(releaseRow.trackCount ? { trackCount: releaseRow.trackCount } : {}),
      labels: ((releaseRow.labels as Array<{ name?: string; catalogNumber?: string }> | null) ?? []),
      media: ((releaseRow.media as Array<{ format?: string }> | null) ?? []),
      ...(releaseRow.mbid ? { mbid: releaseRow.mbid } : {}),
      ...(releaseRow.discogsReleaseId ? { discogsReleaseId: releaseRow.discogsReleaseId } : {}),
      artists: albumCredits,
    },
    releaseGroup: {
      title: releaseGroup.title,
      ...(releaseGroup.primaryType ? { primaryType: releaseGroup.primaryType } : {}),
      ...(formatDate(releaseGroup.firstReleaseDate) ? { firstReleaseDate: formatDate(releaseGroup.firstReleaseDate)! } : {}),
      ...(releaseGroup.mbid ? { mbid: releaseGroup.mbid } : {}),
      ...(releaseGroup.discogsmasterId ? { discogsMasterId: releaseGroup.discogsmasterId } : {}),
      secondaryTypes: (releaseGroup.secondaryTypes as string[] | null) ?? [],
      artistCredit: albumCredits,
    },
    ...(canonicalTrack
      ? {
          track: {
            ...(canonicalTrack.title ? { title: canonicalTrack.title } : {}),
            ...(canonicalTrack.number ? { number: canonicalTrack.number } : {}),
            ...(canonicalTrack.position !== null && canonicalTrack.position !== undefined ? { position: canonicalTrack.position } : {}),
            ...(canonicalTrack.mediumNo ? { mediumNo: canonicalTrack.mediumNo } : {}),
            artistCredit: creditsOf(canonicalTrack.artistCredit).length ? creditsOf(canonicalTrack.artistCredit) : albumCredits,
          },
        }
      : {}),
    artistCredits: albumCredits,
    effectiveGenres: genres,
    locks,
  };

  return {
    ok: true,
    value: {
      resolved: resolveFields(input),
      releaseId: album.releaseId,
      localAlbumId: album.id,
      canonicalTrackId: canonicalTrack?.id ?? null,
    },
  };
}

/**
 * Older entry point: resolve for a known release without the per-file track
 * mapping (kept for callers that already know the release; prefer
 * resolveMetadataForFile).
 */
export async function resolveMetadata(
  ctx: WorkerContext,
  libraryId: string,
  audioFileId: string,
  releaseId: string,
): Promise<ResolvedMetadata> {
  const [file] = await ctx.db.select({ id: audioFiles.id }).from(audioFiles).where(eq(audioFiles.id, audioFileId));
  if (!file) throw new Error(`Audio file not found: ${audioFileId}`);
  const r = await resolveMetadataForFile(ctx, libraryId, audioFileId);
  if (r.ok && r.value.releaseId === releaseId) return r.value.resolved;
  const [releaseRow] = await ctx.db.select().from(releases).where(eq(releases.id, releaseId));
  if (!releaseRow) throw new Error(`Release not found: ${releaseId}`);
  const [releaseGroup] = await ctx.db.select().from(releaseGroups).where(eq(releaseGroups.id, releaseRow.releaseGroupId));
  if (!releaseGroup) throw new Error(`Release group not found: ${releaseRow.releaseGroupId}`);
  const albumCredits = creditsOf(releaseGroup.artistCredit);
  return resolveFields({
    release: {
      title: releaseRow.title,
      ...(formatDate(releaseRow.date) ? { date: formatDate(releaseRow.date)! } : {}),
      ...(releaseRow.mbid ? { mbid: releaseRow.mbid } : {}),
      labels: ((releaseRow.labels as Array<{ name?: string; catalogNumber?: string }> | null) ?? []),
      media: ((releaseRow.media as Array<{ format?: string }> | null) ?? []),
      artists: albumCredits,
    },
    releaseGroup: {
      title: releaseGroup.title,
      ...(releaseGroup.mbid ? { mbid: releaseGroup.mbid } : {}),
      artistCredit: albumCredits,
    },
    artistCredits: albumCredits,
    locks: [],
  });
}

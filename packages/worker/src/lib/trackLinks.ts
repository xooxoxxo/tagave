/**
 * Per-track linking: match local_tracks to canonical_tracks and store the links (0026).
 *
 * Spec §4, §5: LinkAlbumTracks, fillTrackIdsFromCache, ensureTrackMbids.
 */

import { eq, and, isNull } from 'drizzle-orm';
import {
  localTracks, canonicalTracks, localAlbums, releases,
} from '@liner/db';
import {
  alignTracks, type LocalTrack, type MatchingCanonicalTrack,
} from '@liner/core';
import type { WorkerContext } from './context.js';
import type { CanonicalRelease } from '@liner/core';
import { cached, cacheKey, TTLs } from './providerCache.js';
import { getProviders, libraryProviderSettings, mbCall } from './providers.js';
import { upsertCanonical } from './canonical.js';

export interface LocalTrackRowForView {
  id: string;
  discNo: number | null;
  trackNo: number | null;
  titleGuess: string | null;
  artistGuess: string | null;
  durationMs: number | null;
}

/**
 * Build local track views for matching (same format as identifyAlbum uses).
 * Sorted by (disc??1, track??0), 0-based index, duration in seconds, disc only when discsKnown.
 * Does NOT mutate input.
 */
export function localTrackViews(rows: LocalTrackRowForView[]): {
  tracks: LocalTrack[];
  order: LocalTrackRowForView[];
  discsKnown: boolean;
  discCount: number;
} {
  // Check if any track has disc_no set
  const discsKnown = rows.some(r => r.discNo != null);

  // Sort by (disc??1, track??0)
  const sorted = [...rows].sort((a, b) => {
    const discA = a.discNo ?? 1;
    const discB = b.discNo ?? 1;
    if (discA !== discB) return discA - discB;
    const trackA = a.trackNo ?? 0;
    const trackB = b.trackNo ?? 0;
    return trackA - trackB;
  });

  // Compute disc count
  const discNos = new Set<number>();
  for (const r of sorted) {
    if (r.discNo != null) {
      discNos.add(r.discNo);
    }
  }
  const discCount = discsKnown ? Math.max(1, discNos.size) : 1;

  // Build LocalTrack array for matching
  const tracks: LocalTrack[] = sorted.map((r, index) => {
    const trackObj: any = {
      title: r.titleGuess ?? '',
      duration: (r.durationMs ?? 0) / 1000, // ms to seconds
      index,
    };
    if (r.artistGuess) {
      trackObj.artist = r.artistGuess;
    }
    if (discsKnown) {
      trackObj.disc = r.discNo ?? 1;
    }
    return trackObj as LocalTrack;
  });

  return { tracks, order: sorted, discsKnown, discCount };
}

/**
 * Build canonical track views for matching (sorted by medium, position).
 */
export function canonicalTrackViews(
  rows: Array<{
    id: string;
    mediumNo: number | null;
    position: number | null;
    title: string;
    artistCredit: unknown;
    lengthMs: number | null;
    recordingMbid: string | null;
    trackMbid: string | null;
  }>,
): {
  tracks: MatchingCanonicalTrack[];
  order: typeof rows;
} {
  // Sort by (medium, position)
  const sorted = [...rows].sort((a, b) => {
    const medA = a.mediumNo ?? 1;
    const medB = b.mediumNo ?? 1;
    if (medA !== medB) return medA - medB;
    const posA = a.position ?? 0;
    const posB = b.position ?? 0;
    return posA - posB;
  });

  // Build MatchingCanonicalTrack array for matching
  const tracks: MatchingCanonicalTrack[] = sorted.map((r, index) => {
    const ac = r.artistCredit as any;
    let artist: string | undefined;
    if (ac && typeof ac === 'object') {
      if (Array.isArray(ac)) {
        artist = ac.map((c: any) => c.name ?? '').filter(Boolean).join('; ') || undefined;
      } else if (ac.name) {
        artist = ac.name;
      }
    }

    const track: MatchingCanonicalTrack = {
      title: r.title,
      duration: (r.lengthMs ?? 0) / 1000, // ms to seconds
      index,
    };
    if (artist) {
      track.artist = artist;
    }
    if (r.recordingMbid) {
      track.recordingId = r.recordingMbid;
    }
    if (r.mediumNo) {
      track.medium = r.mediumNo;
    }
    return track;
  });

  return { tracks, order: sorted };
}

export interface LinkResult {
  localAlbumId: string;
  releaseId: string;
  total: number;
  linked: number;
  unaligned: number;
}

/**
 * Link all local tracks of an album to canonical tracks and write results to DB.
 * Idempotent: re-running after canonical tracks are re-fetched (stable ids) keeps the same ids.
 * Returns null if data is missing (logged as warn, not error).
 */
export async function linkAlbumTracks(
  ctx: WorkerContext,
  localAlbumId: string,
  opts?: { releaseId?: string },
): Promise<LinkResult | null> {
  // Load album
  const album = (await ctx.db.select().from(localAlbums).where(eq(localAlbums.id, localAlbumId as any)))[0];
  if (!album) {
    ctx.logger.warn({ localAlbumId }, 'album not found');
    return null;
  }

  // Require matched state and a release id
  if (album.state !== 'matched' || (!album.releaseId && !opts?.releaseId)) {
    ctx.logger.warn({ localAlbumId, state: album.state, releaseId: album.releaseId }, 'album not matched or no release id');
    return null;
  }

  const releaseId = opts?.releaseId ?? album.releaseId!;

  // Load all local_tracks of the album
  const localRows = await ctx.db
    .select()
    .from(localTracks)
    .where(eq(localTracks.localAlbumId, localAlbumId as any));

  // Load all canonical_tracks of the release
  const canonicalRows = await ctx.db
    .select()
    .from(canonicalTracks)
    .where(eq(canonicalTracks.releaseId, releaseId as any));

  // If either is empty, mark linked and return
  if (localRows.length === 0 || canonicalRows.length === 0) {
    await ctx.db
      .update(localAlbums)
      .set({ tracksLinkedAt: new Date() })
      .where(eq(localAlbums.id, localAlbumId as any));

    return {
      localAlbumId,
      releaseId,
      total: localRows.length,
      linked: 0,
      unaligned: localRows.length,
    };
  }

  // Build views
  const localView = localTrackViews(localRows as any);
  const canonicalView = canonicalTrackViews(canonicalRows as any);

  // Align tracks
  const alignment = alignTracks(localView.tracks, canonicalView.tracks);

  // Update all local_tracks in one statement: build parallel arrays
  const ids = localRows.map(r => r.id);
  const alignedIndices = alignment.map(a => a.canonicalIndex);
  const distances = alignment.map(a => a.distance);

  // Map indices to canonical track ids and track_mbids
  const canonicalIds = alignedIndices.map(idx => (idx !== null ? canonicalView.order[idx]!.id : null));
  const trackMbids = alignedIndices.map(idx => (idx !== null ? canonicalView.order[idx]!.trackMbid : null));

  // States: aligned → 'matched', unaligned → 'unmatched'
  const states = alignment.map(a => (a.canonicalIndex !== null ? 'matched' : 'unmatched'));

  // One statement updates all rows
  await ctx.sql`
    update local_tracks lt
    set
      canonical_track_id = t.canonical_track_id,
      match_distance = t.distance,
      state = t.state
    from unnest(
      ${ids}::uuid[],
      ${canonicalIds}::uuid[],
      ${distances.map(d => d.toFixed(4))}::numeric[],
      ${states}::text[]
    ) as t(id, canonical_track_id, distance, state)
    where lt.id = t.id
  `;

  // Mark album as linked
  await ctx.db
    .update(localAlbums)
    .set({ tracksLinkedAt: new Date() })
    .where(eq(localAlbums.id, localAlbumId as any));

  const linked = alignment.filter(a => a.canonicalIndex !== null).length;
  const unaligned = alignment.filter(a => a.canonicalIndex === null).length;

  ctx.logger.info(
    { localAlbumId, releaseId, total: localRows.length, linked, unaligned },
    'album tracks linked',
  );

  return { localAlbumId, releaseId, total: localRows.length, linked, unaligned };
}

/**
 * Fill recording_mbid and track_mbid columns from provider_cache for an MB release.
 * Zero provider calls. Returns null if no cache row found.
 */
export async function fillTrackIdsFromCache(
  ctx: WorkerContext,
  releaseId: string,
): Promise<{ filled: number } | null> {
  // Load release
  const release = (await ctx.db.select().from(releases).where(eq(releases.id, releaseId as any)))[0];
  if (!release || !release.mbid) {
    return null; // Not an MB release
  }

  // Load canonical tracks that miss recording/track mbid
  const tracksToFill = await ctx.db
    .select()
    .from(canonicalTracks)
    .where(
      and(
        eq(canonicalTracks.releaseId, releaseId as any),
        isNull(canonicalTracks.recordingMbid),
      ),
    );

  if (tracksToFill.length === 0) {
    return { filled: 0 }; // All already have ids
  }

  // Read from provider_cache (ignore expiry)
  const cacheRow = (await ctx.sql`
    select payload from provider_cache
    where provider = 'musicbrainz' and cache_key = ${cacheKey('release', release.mbid)}
  `)[0];

  if (!cacheRow) {
    return null; // No cache entry
  }

  const payload = cacheRow.payload as CanonicalRelease;
  if (!payload.tracks) {
    return { filled: 0 };
  }

  // Map payload tracks by (mediumNumber ?? 1, position)
  const payloadMap = new Map<string, { recordingMbid?: string | undefined; trackMbid?: string | undefined }>();
  for (const t of payload.tracks) {
    const key = `${t.mediumNumber ?? 1}:${t.position}`;
    const data: { recordingMbid?: string; trackMbid?: string } = {};
    if (t.recordingId) data.recordingMbid = t.recordingId;
    if (t.trackId) data.trackMbid = t.trackId;
    payloadMap.set(key, data);
  }

  // Update only NULL columns in canonical_tracks
  let filled = 0;
  for (const track of tracksToFill) {
    const key = `${track.mediumNo}:${track.position}`;
    const data = payloadMap.get(key);
    if (!data) continue;

    const updates: Partial<typeof canonicalTracks.$inferInsert> = {};
    if (!track.recordingMbid && data.recordingMbid) {
      updates.recordingMbid = data.recordingMbid;
    }
    if (!track.trackMbid && data.trackMbid) {
      updates.trackMbid = data.trackMbid;
    }

    if (Object.keys(updates).length > 0) {
      await ctx.db
        .update(canonicalTracks)
        .set(updates as any)
        .where(eq(canonicalTracks.id, track.id as any));
      filled++;
    }
  }

  return { filled };
}

/**
 * Refresh track_mbid ids from MusicBrainz if missing (0026).
 * Fetches release once with cache bypass, upserts canonical, marks releases.tracks_refreshed_at.
 * Returns 'ok' | 'refreshed' | 'skipped' | 'failed'.
 * 'ok' and 'refreshed' both mean success; 'ok' means nothing was missing or done.
 * For Discogs or if already refreshed, returns 'skipped'.
 */
export async function ensureTrackMbids(
  ctx: WorkerContext,
  libraryId: string,
  releaseId: string,
): Promise<'ok' | 'refreshed' | 'skipped' | 'failed'> {
  const release = (await ctx.db.select().from(releases).where(eq(releases.id, releaseId as any)))[0];
  if (!release) {
    return 'skipped';
  }

  // Only for MB releases
  if (!release.mbid) {
    return 'skipped';
  }

  // If already refreshed, skip
  if (release.tracksRefreshedAt) {
    return 'skipped';
  }

  // Check if any canonical track is missing track_mbid
  const needsRefresh = (await ctx.db
    .select()
    .from(canonicalTracks)
    .where(
      and(
        eq(canonicalTracks.releaseId, releaseId as any),
        isNull(canonicalTracks.trackMbid),
      ),
    )
    .limit(1))[0];

  if (!needsRefresh) {
    // Mark as refreshed (all tracks already have mbids)
    await ctx.db
      .update(releases)
      .set({ tracksRefreshedAt: new Date() })
      .where(eq(releases.id, releaseId as any));
    return 'ok';
  }

  // Fetch fresh release from MB with cache bypass
  const settings = await libraryProviderSettings(ctx, libraryId);
  const providers = getProviders(settings);

  let fresh: CanonicalRelease;
  try {
    fresh = await cached(
      ctx.sql,
      'musicbrainz',
      cacheKey('release', release.mbid),
      TTLs.mbRelease,
      () => mbCall(ctx, () => providers.mb.getRelease(release.mbid!, { priority: 'background' })),
      { bypass: true },
    );
  } catch (err) {
    ctx.logger.warn({ err, releaseId, mbid: release.mbid }, 'mb release fetch failed');
    return 'failed';
  }

  // Upsert canonical (stable identity, so links survive)
  await upsertCanonical(ctx, fresh);

  // Mark refreshed
  await ctx.db
    .update(releases)
    .set({ tracksRefreshedAt: new Date() })
    .where(eq(releases.id, releaseId as any));

  return 'refreshed';
}

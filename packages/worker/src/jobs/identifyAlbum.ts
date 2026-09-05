import { eq, inArray } from 'drizzle-orm';
import {
  albumMatches, audioFiles, localAlbums, localTracks, matchCandidates, releases,
} from '@liner/db';
import {
  scoreCandidates, MATCHING_THRESHOLDS, discogsIdsFromUrlRelations,
  type CanonicalRelease, type ReleaseQuery,
  pickByChipRule, chipCounts,
} from '@liner/core';
import type { WorkerContext } from '../lib/context.js';
import { cached, cacheKey, TTLs, stripDiscogs } from '../lib/providerCache.js';
import {
  libraryProviderSettings, getProviders, discogsCall, mbCall, type Providers,
} from '../lib/providers.js';
import { upsertCanonical, upsertDiscogsSidecars } from '../lib/canonical.js';

export interface IdentifyAlbumJobData {
  localAlbumId: string;
  /** re-run even when state is not pending/unidentified */
  force?: boolean;
  /** IDN-6 manual entry: match this MB release MBID, bypassing search and
   * thresholds; decided_by=user */
  pinnedMbid?: string;
  /** IDN-6 manual entry: Discogs release or master (master → its main
   * release), same semantics as pinnedMbid */
  pinnedDiscogs?: { kind: 'release' | 'master'; id: number };
}

/** spec §10.3 budget: MB lookups per album; Discogs is consulted only when
 * MB did not produce a strong candidate, and then fetches at most two. */
const MAX_LOOKUPS_PER_ALBUM = 3;
const MAX_DISCOGS_FETCHES = 2;

interface EmbeddedIds {
  albumMbid?: string;
  rgMbid?: string;
  barcode?: string;
}

function embeddedIdsOf(tagsRaw: unknown): EmbeddedIds {
  const common = ((tagsRaw as { common?: Record<string, unknown> } | null)?.common ?? {}) as Record<string, unknown>;
  const one = (v: unknown): string | undefined => {
    const s = Array.isArray(v) ? v[0] : v;
    return typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s.trim()) ? s.trim().toLowerCase() : undefined;
  };
  const bc = common['barcode'];
  const albumMbid = one(common['musicbrainz_albumid']);
  const rgMbid = one(common['musicbrainz_releasegroupid']);
  const out: EmbeddedIds = {};
  if (albumMbid) out.albumMbid = albumMbid;
  if (rgMbid) out.rgMbid = rgMbid;
  if (typeof bc === 'string' && bc.trim()) out.barcode = bc.trim();
  return out;
}

const bg = { priority: 'background' as const };

// Cache OUTSIDE, pace INSIDE: a provider_cache hit must not spend a slot.
export function mbRelease(ctx: WorkerContext, p: Providers, mbid: string): Promise<CanonicalRelease> {
  return cached(ctx.sql, 'musicbrainz', cacheKey('release', mbid), TTLs.mbRelease,
    () => mbCall(ctx, () => p.mb.getRelease(mbid, bg)));
}
function mbSearch(ctx: WorkerContext, p: Providers, q: ReleaseQuery) {
  return cached(ctx.sql, 'musicbrainz', cacheKey('search', JSON.stringify(q)), TTLs.discogsSearch,
    () => mbCall(ctx, () => p.mb.searchReleases(q, bg)));
}
export function discogsRelease(ctx: WorkerContext, p: Providers, id: number | string): Promise<CanonicalRelease> {
  return cached(ctx.sql, 'discogs', cacheKey('release', id), TTLs.discogsEntity,
    () => discogsCall(ctx, p, () => p.discogs.getRelease(String(id), bg)), { strip: stripDiscogs });
}
export function discogsMaster(ctx: WorkerContext, p: Providers, id: number | string) {
  return cached(ctx.sql, 'discogs', cacheKey('master', id), TTLs.discogsEntity,
    () => discogsCall(ctx, p, () => p.discogs.getMaster(String(id), bg)), { strip: stripDiscogs });
}
export function discogsSearch(ctx: WorkerContext, p: Providers, q: ReleaseQuery) {
  return cached(ctx.sql, 'discogs', cacheKey('search', JSON.stringify(q)), TTLs.discogsSearch,
    () => discogsCall(ctx, p, () => p.discogs.searchReleases(q, bg)), { strip: stripDiscogs });
}

/** Persist a fetched release and, when it is a Discogs release or an MB
 * release whose url-rels name a Discogs release, the bridge sidecars
 * (external_ids, id columns, genres/styles, primary image). */
export async function persistFetched(ctx: WorkerContext, r: CanonicalRelease): Promise<{ releaseId: string; releaseGroupId: string }> {
  const ids = await upsertCanonical(ctx, r);
  if (r.source === 'discogs') {
    const primary = r.images?.find((i) => i.primary) ?? r.images?.[0];
    await upsertDiscogsSidecars(ctx, {
      ...ids,
      discogsReleaseId: Number(r.id),
      ...(r.discogsMasterId ? { discogsMasterId: Number(r.discogsMasterId) } : {}),
      ...(r.genres ? { genres: r.genres } : {}),
      ...(r.styles ? { styles: r.styles } : {}),
      ...(primary ? { primaryImage: primary } : {}),
      confidence: 1,
      source: 'provider',
    });
  } else {
    const rel = discogsIdsFromUrlRelations(r.urlRelations);
    if (rel.releaseId || rel.masterId) {
      // ENR-1 bridge step 1 at zero cost; enrich.release fills genres/images.
      await upsertDiscogsSidecars(ctx, {
        ...ids,
        ...(rel.releaseId ? { discogsReleaseId: rel.releaseId } : {}),
        ...(rel.masterId ? { discogsMasterId: rel.masterId } : {}),
        confidence: 1,
        source: 'provider_relationship',
      });
    }
  }
  return ids;
}

export async function identifyAlbumJob(ctx: WorkerContext, data: IdentifyAlbumJobData): Promise<void> {
  const albumRows = await ctx.db
    .select()
    .from(localAlbums)
    .where(eq(localAlbums.id, data.localAlbumId))
    .limit(1);
  const album = albumRows[0];
  if (!album) return;
  const pinned = !!(data.pinnedMbid || data.pinnedDiscogs);
  if (!pinned && !data.force && album.state !== 'pending' && album.state !== 'unidentified') return;
  if (!pinned && (!album.titleGuess || !album.artistGuess)) {
    await ctx.db.update(localAlbums)
      .set({ state: 'unidentified', updatedAt: new Date() })
      .where(eq(localAlbums.id, album.id));
    return;
  }

  const settings = await libraryProviderSettings(ctx, album.libraryId);
  const p = getProviders(settings); // throws without a contact string (PLT-4)

  const tracks = await ctx.db
    .select()
    .from(localTracks)
    .where(eq(localTracks.localAlbumId, album.id));
  if (tracks.length === 0) return;

  // Embedded IDs from the first tracks' file tags (IDN-1a).
  const fileRows = await ctx.db
    .select({ tagsRaw: audioFiles.tagsRaw })
    .from(audioFiles)
    .where(inArray(audioFiles.id, tracks.slice(0, 3).map((t) => t.audioFileId)));
  let embedded: EmbeddedIds = {};
  for (const f of fileRows) {
    embedded = { ...embeddedIdsOf(f.tagsRaw), ...embedded };
  }

  const local = {
    artist: album.artistGuess ?? '',
    title: album.titleGuess ?? '',
    tracks: tracks
      .sort((a, b) => (a.discNo ?? 1) - (b.discNo ?? 1) || (a.trackNo ?? 0) - (b.trackNo ?? 0))
      .map((t, i) => ({
        title: t.titleGuess ?? '',
        ...(t.artistGuess ? { artist: t.artistGuess } : {}),
        duration: (t.durationMs ?? 0) / 1000, // core/matching works in seconds
        index: i,
      })),
    ...(album.yearGuess ? { year: album.yearGuess } : {}),
    ...(embedded.albumMbid ? { embeddedMbId: embedded.albumMbid } : {}),
    ...(embedded.rgMbid ? { embeddedMbRgId: embedded.rgMbid } : {}),
    ...(embedded.barcode ? { barcode: embedded.barcode } : {}),
  };

  // core/matching input: seconds + 0-based indices; provider tracks are ms.
  const toScorable = (r: CanonicalRelease) => ({
    id: r.id,
    releaseGroupId: r.releaseGroupId,
    title: r.title,
    artists: r.artists,
    tracks: (r.tracks ?? []).map((t, i) => ({
      title: t.title,
      ...(t.artists?.[0] ? { artist: t.artists[0] } : {}),
      duration: (t.duration ?? 0) / 1000,
      index: i,
      ...(t.recordingId ? { recordingId: t.recordingId } : {}),
    })),
    ...(r.year ? { year: r.year } : {}),
    ...(r.country ? { country: r.country } : {}),
    ...(r.barcode ? { barcode: r.barcode } : {}),
    ...(r.label ? { label: r.label } : {}),
    source: r.source,
  });

  // Candidate generation (IDN-1): pinned (IDN-6) short-circuits, then
  // embedded MBID, then MB search cascade, then Discogs (IDN-1c).
  const fetched: CanonicalRelease[] = [];
  try {
    if (data.pinnedMbid) {
      fetched.push(await mbRelease(ctx, p, data.pinnedMbid));
    } else if (data.pinnedDiscogs) {
      let releaseId: number | undefined = data.pinnedDiscogs.id;
      if (data.pinnedDiscogs.kind === 'master') {
        const master = await discogsMaster(ctx, p, data.pinnedDiscogs.id);
        releaseId = master.mainReleaseId;
        if (!releaseId) {
          ctx.logger.warn({ album: album.titleGuess, masterId: data.pinnedDiscogs.id }, 'identify: pinned master has no main release');
          return;
        }
      }
      fetched.push(await discogsRelease(ctx, p, releaseId));
    } else if (embedded.albumMbid) {
      fetched.push(await mbRelease(ctx, p, embedded.albumMbid));
    }

    if (fetched.length === 0 && !pinned) {
      // Cascade: exact artist phrase often misses (credit variations), so a
      // title-only pass follows and the scorer judges artist distance.
      let found = await mbSearch(ctx, p, {
        albumTitle: album.titleGuess as string,
        artistName: album.artistGuess as string,
        ...(embedded.barcode ? { barcode: embedded.barcode } : {}),
      });
      if (found.length === 0) {
        found = await mbSearch(ctx, p, { albumTitle: album.titleGuess as string });
      }
      // Fetch full tracklists for the top few candidates whose track counts
      // are not impossible (spec §10.3 budget: cap lookups per album).
      const plausible = found
        .filter((c) => !c.release.tracks?.length || Math.abs(c.release.tracks.length - tracks.length) <= 5)
        .slice(0, MAX_LOOKUPS_PER_ALBUM);
      for (const cand of plausible) {
        fetched.push(await mbRelease(ctx, p, cand.release.id));
      }
    }
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (pinned && status === 404) {
      ctx.logger.warn({ album: album.titleGuess, pinned: data.pinnedMbid ?? data.pinnedDiscogs }, 'identify: pinned id not found');
      return; // bad user input; leave state untouched
    }
    ctx.logger.warn({ album: album.titleGuess, err: (err as Error).message }, 'identify: provider error');
    throw err; // pg-boss retry with backoff
  }

  // IDN-1c: Discogs when MB found nothing or nothing strong. Discogs errors
  // never fail the job — MB candidates are still decided below.
  if (!pinned) {
    const mbBest = fetched.length ? scoreCandidates(local, fetched.map(toScorable))[0] : undefined;
    if (!mbBest || mbBest.distance > MATCHING_THRESHOLDS.strong) {
      try {
        const hits = await discogsSearch(ctx, p, {
          albumTitle: album.titleGuess as string,
          artistName: album.artistGuess as string,
          ...(embedded.barcode ? { barcode: embedded.barcode } : {}),
        });
        for (const cand of hits.slice(0, MAX_DISCOGS_FETCHES)) {
          fetched.push(await discogsRelease(ctx, p, cand.release.id));
        }
      } catch (err) {
        ctx.logger.warn({ album: album.titleGuess, err: (err as Error).message }, 'identify: Discogs error (continuing with MB)');
      }
    }
  }

  if (fetched.length === 0) {
    await ctx.db.update(localAlbums)
      .set({ state: 'unidentified', updatedAt: new Date() })
      .where(eq(localAlbums.id, album.id));
    return;
  }

  // Score (IDN-2).
  const scored = scoreCandidates(local, fetched.map(toScorable));

  // Persist canonical entities + candidates.
  const releaseDbIds = new Map<string, string>();
  for (const r of fetched) {
    releaseDbIds.set(r.id, (await persistFetched(ctx, r)).releaseId);
  }
  await ctx.db.delete(matchCandidates).where(eq(matchCandidates.localAlbumId, album.id));
  for (const s of scored) {
    const relDb = releaseDbIds.get(s.id);
    if (!relDb) continue;
    const source = data.pinnedMbid ? 'user_mbid'
      : data.pinnedDiscogs ? 'user_discogs'
      : s.source === 'discogs' ? 'discogs_search'
      : embedded.albumMbid ? 'mbid' : 'mb_search';
    await ctx.db.insert(matchCandidates).values({
      localAlbumId: album.id,
      releaseId: relDb,
      distance: s.distance.toFixed(4),
      breakdown: s.breakdown,
      source,
    });
  }

  const goLive = async (releaseDb: string, status: 'auto' | 'confirmed', decidedBy: 'system' | 'user', distance: number, reason: string) => {
    if (status === 'confirmed') {
      await ctx.sql`
        update album_matches set status = 'rejected', reason = 'superseded by manual entry'
        where local_album_id = ${album.id} and status in ('auto', 'confirmed')`;
    }
    await ctx.db.insert(albumMatches).values({
      libraryId: album.libraryId,
      localAlbumId: album.id,
      releaseId: releaseDb,
      distance: distance.toFixed(4),
      status,
      decidedBy,
      reason,
    });
    const rgRow = await ctx.db
      .select({ rgId: releases.releaseGroupId })
      .from(releases).where(eq(releases.id, releaseDb)).limit(1);
    await ctx.db.update(localAlbums)
      .set({ state: 'matched', releaseId: releaseDb, releaseGroupId: rgRow[0]?.rgId ?? null, updatedAt: new Date() })
      .where(eq(localAlbums.id, album.id));
    // ENR-1: bridge + enrich the release of record.
    await ctx.boss.send('enrich.release', { releaseId: releaseDb }, { singletonKey: `enrich:${releaseDb}` });
  };

  // IDN-6: a pinned entry is the owner's decision — match it outright, with
  // the computed distance kept for provenance.
  if (pinned) {
    const top = scored[0];
    const topDb = top ? releaseDbIds.get(top.id) : undefined;
    if (!top || !topDb) return;
    await goLive(topDb, 'confirmed', 'user', top.distance,
      data.pinnedMbid ? 'manual MBID entry (IDN-6)' : 'manual Discogs entry (IDN-6)');
    return;
  }

  // Decide (IDN-3).
  const best = scored[0];
  const second = scored[1];
  const bestDb = best ? releaseDbIds.get(best.id) : undefined;
  const gapDemoted = best && second && second.distance - best.distance < MATCHING_THRESHOLDS.recGapThresh
    && second.distance <= MATCHING_THRESHOLDS.medium && best.distance > 0;
  const trackParity = best ? (best.tracks?.length ?? 0) === local.tracks.length : false;

  if (best && bestDb && best.distance <= MATCHING_THRESHOLDS.strong && trackParity && !gapDemoted) {
    ctx.logger.info({ album: album.titleGuess, source: best.source, distance: best.distance }, 'identify: auto-accept');
    await goLive(bestDb, 'auto', 'system', best.distance, `auto-accept: distance ${best.distance.toFixed(4)} (${best.source})`);
  } else if (best && best.distance <= MATCHING_THRESHOLDS.medium) {
    // Owner chip rule (2026-09-05): no reds + ≥3 greens auto-accepts even in
    // the review band; fewest yellows wins. Mirrors hand-review outcomes.
    const inBand = scored.filter((c) => c.distance <= MATCHING_THRESHOLDS.medium);
    const pick = pickByChipRule(inBand.map((c) => ({ breakdown: c.breakdown, distance: c.distance })));
    const chosen = pick >= 0 ? inBand[pick] : undefined;
    const chosenDb = chosen ? releaseDbIds.get(chosen.id) : undefined;
    if (chosen && chosenDb) {
      const cc = chipCounts(chosen.breakdown);
      await ctx.db.insert(albumMatches).values({
        libraryId: album.libraryId,
        localAlbumId: album.id,
        releaseId: chosenDb,
        distance: chosen.distance.toFixed(4),
        status: 'auto',
        decidedBy: 'system',
        reason: `chip-rule auto-accept: ${cc.greens} green, ${cc.yellows} yellow, 0 red (distance ${chosen.distance.toFixed(4)})`,
      });
      const rgRow2 = await ctx.db
        .select({ rgId: releases.releaseGroupId })
        .from(releases).where(eq(releases.id, chosenDb)).limit(1);
      await ctx.db.update(localAlbums)
        .set({
          state: 'matched',
          releaseId: chosenDb,
          releaseGroupId: rgRow2[0]?.rgId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(localAlbums.id, album.id));
      return;
    }
    await ctx.db.update(localAlbums)
      .set({ state: 'needs_review', updatedAt: new Date() })
      .where(eq(localAlbums.id, album.id));
  } else {
    await ctx.db.update(localAlbums)
      .set({ state: 'unidentified', updatedAt: new Date() })
      .where(eq(localAlbums.id, album.id));
  }
}

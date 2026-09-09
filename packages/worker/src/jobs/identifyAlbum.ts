import { eq, inArray } from 'drizzle-orm';
import {
  albumMatches, audioFiles, localAlbums, localTracks, matchCandidates, releases,
} from '@liner/db';
import {
  scoreCandidates, MATCHING_THRESHOLDS, MAX_ALIGN_TRACKS, discogsIdsFromUrlRelations,
  type CanonicalRelease, type ReleaseQuery,
  pickByChipRule, chipCounts,
} from '@liner/core';
import type { WorkerContext } from '../lib/context.js';
import { notifyQueueChanged } from './progress.js';
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
  /** XO-379 sweep tier: ask Discogs first, MusicBrainz only when Discogs found nothing acceptable */
  discogsFirst?: boolean;
  /** IDN-5: release MBIDs the AcoustID lookup ranked for this album; fetched
   * and scored beside the search candidates, never trusted blindly */
  acoustidMbids?: string[];
  /** IDN-5: per release MBID, the share of the album's tracks whose fingerprint
   * matched a recording on it (acoustid.lookup's coverage) */
  acoustidCoverage?: Record<string, number>;
}

/** spec §10.3 budget: MB lookups per album; Discogs is consulted only when
 * MB did not produce a strong candidate, and then fetches at most two. */
const MAX_LOOKUPS_PER_ALBUM = 3;
const MAX_DISCOGS_FETCHES = 2;
/** IDN-5: a release that explains this share of the album's fingerprints, with
 * track parity (±1), is the album — whatever the tags say. */
const ACOUSTID_ACCEPT_COVERAGE = 0.8;

/** provenance of a candidate / decision (match_candidates.source, album_matches.source) */
export type CandidateSource = 'mbid' | 'mb_search' | 'discogs_search' | 'user_mbid' | 'user_discogs' | 'acoustid';

export interface EmbeddedIds {
  albumMbid?: string;
  rgMbid?: string;
  barcode?: string;
}

export function embeddedIdsOf(tagsRaw: unknown): EmbeddedIds {
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

/** IDN-1a fast path verdict for the release named by the file tags: a strong
 * score with track parity is a hit; anything else also runs the search
 * cascade (stale or edition-mismatched tags are common in hand-ripped
 * archives) and lets the scorer choose. */
export function fastPathOutcome(distance: number, providerTrackCount: number, localTrackCount: number): 'hit' | 'weak' {
  return distance <= MATCHING_THRESHOLDS.strong && providerTrackCount === localTrackCount ? 'hit' : 'weak';
}

const bg = { priority: 'background' as const };

// Cache OUTSIDE, pace INSIDE: a provider_cache hit must not spend a slot.
export function mbRelease(ctx: WorkerContext, p: Providers, mbid: string): Promise<CanonicalRelease> {
  return cached(ctx.sql, 'musicbrainz', cacheKey('release', mbid), TTLs.mbRelease,
    () => mbCall(ctx, () => p.mb.getRelease(mbid, bg)));
}
export function mbSearch(ctx: WorkerContext, p: Providers, q: ReleaseQuery) {
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
  // Triage bookkeeping (XO-309): attempts + last run feed the sweep top-up
  // (eligibility) and the triage view; the reason explains every non-match.
  await ctx.db.update(localAlbums)
    .set({ identifyAttempts: album.identifyAttempts + 1, lastIdentifyAt: new Date() })
    .where(eq(localAlbums.id, album.id));
  const giveUp = async (reason: 'no_tags' | 'no_candidates' | 'weak_candidates' | 'ambiguous') => {
    const state = reason === 'ambiguous' ? 'needs_review' : 'unidentified';
    await ctx.db.update(localAlbums)
      .set({ state, identifyReason: reason, updatedAt: new Date() })
      .where(eq(localAlbums.id, album.id));
    await notifyQueueChanged(ctx, album.libraryId, album.id, state);
  };
  if (!pinned && (!album.titleGuess || !album.artistGuess)) {
    await giveUp('no_tags');
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
  // Fast-path eligibility is a library metric (XO-309): remember the tag id.
  if ((embedded.albumMbid ?? null) !== (album.embeddedMbid ?? null)) {
    await ctx.db.update(localAlbums)
      .set({ embeddedMbid: embedded.albumMbid ?? null })
      .where(eq(localAlbums.id, album.id));
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
        // Disc/track within the disc (XO-379): the matcher aligns per medium
        // when it knows them. disc_no is null for files that carry no disc
        // information, which means disc 1 — leave it off rather than assume.
        ...(t.discNo != null ? { disc: t.discNo } : {}),
        ...(t.trackNo != null ? { position: t.trackNo } : {}),
      })),
    ...(album.discCount ? { discCount: album.discCount } : {}),
    ...(album.yearGuess ? { year: album.yearGuess } : {}),
    ...(embedded.albumMbid ? { embeddedMbId: embedded.albumMbid } : {}),
    ...(embedded.rgMbid ? { embeddedMbRgId: embedded.rgMbid } : {}),
    ...(embedded.barcode ? { barcode: embedded.barcode } : {}),
  };

  // core/matching input: seconds + 0-based indices; provider tracks are ms.
  // How many discs a release has (XO-379): the per-track mediumNumber is the
  // trustworthy signal — MusicBrainz never fills mediaList, and Discogs builds
  // it from format entries, so a 2xCD in one entry reads as one medium. The
  // release-level list is only a fallback for a tracklist that says nothing.
  const mediumCountOf = (r: CanonicalRelease): number | undefined => {
    let maxMedium = 0;
    for (const t of r.tracks ?? []) {
      if (t.mediumNumber && t.mediumNumber > maxMedium) maxMedium = t.mediumNumber;
    }
    return maxMedium > 0 ? maxMedium : (r.mediaList?.length || undefined);
  };
  const toScorable = (r: CanonicalRelease) => {
    const mediumCount = mediumCountOf(r);
    return {
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
        ...(t.mediumNumber ? { medium: t.mediumNumber } : {}),
      })),
      ...(mediumCount !== undefined ? { mediumCount } : {}),
      ...(r.year ? { year: r.year } : {}),
      ...(r.country ? { country: r.country } : {}),
      ...(r.barcode ? { barcode: r.barcode } : {}),
      ...(r.label ? { label: r.label } : {}),
      source: r.source,
    };
  };

  // Candidate generation (IDN-1): pinned (IDN-6) short-circuits, then
  // embedded MBID, then MB search cascade, then Discogs (IDN-1c). Every
  // fetched release remembers how it was found (provenance metrics).
  const fetched: CanonicalRelease[] = [];
  const sourceOf = new Map<string, CandidateSource>();
  const take = (r: CanonicalRelease, source: CandidateSource) => {
    // Search hits carry no track counts, so a mega-compilation is only
    // recognisable after the fetch. Scoring it would pad the alignment to
    // its size (O(n³)) and persisting it writes thousands of rows.
    if ((r.tracks?.length ?? 0) > MAX_ALIGN_TRACKS) {
      ctx.logger.warn({ album: album.titleGuess, candidate: r.title, source, tracks: r.tracks?.length }, 'identify: candidate dropped, tracklist too large');
      return;
    }
    fetched.push(r);
    sourceOf.set(r.id, source);
  };
  let fastPathWeak = false;

  // IDN-1c / XO-379: Discogs candidates. Discogs errors never fail the job.
  const discogsPass = async () => {
    try {
      const hits = await discogsSearch(ctx, p, {
        albumTitle: album.titleGuess as string,
        artistName: album.artistGuess as string,
        ...(embedded.barcode ? { barcode: embedded.barcode } : {}),
      });
      for (const cand of hits.slice(0, MAX_DISCOGS_FETCHES)) {
        take(await discogsRelease(ctx, p, cand.release.id), 'discogs_search');
      }
    } catch (err) {
      ctx.logger.warn({ album: album.titleGuess, err: (err as Error).message }, 'identify: Discogs error (continuing)');
    }
  };
  // "Acceptable" = what the decision below would auto-accept: strong, or in
  // the review band with the owner's chip rule satisfied.
  const bestIsAcceptable = () => {
    if (!fetched.length) return false;
    const scoredNow = scoreCandidates(local, fetched.map(toScorable));
    const top = scoredNow[0]!;
    if (top.distance <= MATCHING_THRESHOLDS.strong && (top.tracks?.length ?? 0) === local.tracks.length) return true;
    const inBand = scoredNow.filter((c) => c.distance <= MATCHING_THRESHOLDS.medium);
    return inBand.length > 0 && pickByChipRule(inBand.map((c) => ({ breakdown: c.breakdown, distance: c.distance }))) >= 0;
  };
  // IDN-5: fingerprint evidence outranks tags. A release that explains ≥ 80 %
  // of the album's fingerprints with track parity (±1) is accepted even when
  // the tag-based distance is poor (per-composer artist tags, kanji titles).
  const acceptedByFingerprint = (r: { id: string; tracks?: unknown[] }): boolean =>
    (data.acoustidCoverage?.[r.id] ?? 0) >= ACOUSTID_ACCEPT_COVERAGE
    && Math.abs((r.tracks?.length ?? 0) - local.tracks.length) <= 1;
  // Sweep tier (owner, 2026-09-09: "first sweep with discogs and do
  // musicbrainz later"): the first pass over an album asks Discogs only —
  // 55/min against MusicBrainz's shared 1 req/s slot — and an album Discogs
  // could not settle waits for its second pass, which runs MB first as before.
  // Manual and triage tiers keep MB first; the embedded-MBID fast path is one
  // MB call and stays.
  const discogsFirst = !!data.discogsFirst && !pinned && !embedded.albumMbid;
  let discogsDone = false;
  try {
    if (discogsFirst) {
      await discogsPass();
      discogsDone = true;
    }
    // AcoustID candidates, best coverage first: one MusicBrainz fetch at a time
    // and stop as soon as one would be accepted — every MB call queues on the
    // shared 1 req/s slot, and fetching all three cost ~2 min per album.
    for (const mbid of data.acoustidMbids ?? []) {
      try {
        const r = await mbRelease(ctx, p, mbid);
        take(r, 'acoustid');
        if (acceptedByFingerprint(r) || bestIsAcceptable()) break;
      } catch (err) {
        ctx.logger.warn({ mbid, err: (err as Error).message }, 'identify: acoustid candidate fetch failed');
      }
    }
    if (data.pinnedMbid) {
      take(await mbRelease(ctx, p, data.pinnedMbid), 'user_mbid');
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
      take(await discogsRelease(ctx, p, releaseId), 'user_discogs');
    } else if (embedded.albumMbid) {
      // IDN-1a fast path: the tags name the release. A stale id (404) falls
      // back to the search cascade instead of failing the job; a weak or
      // edition-mismatched hit keeps its candidate and searches as well.
      const mbid = embedded.albumMbid;
      try {
        const r = await mbRelease(ctx, p, mbid);
        const distance = scoreCandidates(local, [toScorable(r)])[0]?.distance ?? 1;
        const outcome = fastPathOutcome(distance, r.tracks?.length ?? 0, local.tracks.length);
        fastPathWeak = outcome === 'weak';
        ctx.logger.info({ album: album.titleGuess, mbid, outcome, distance }, 'identify: fast path');
        take(r, 'mbid');
      } catch (err) {
        if ((err as { status?: number }).status !== 404) throw err;
        ctx.logger.warn({ album: album.titleGuess, mbid }, 'identify: embedded MBID not found, falling back to search');
      }
    }

    // MusicBrainz cascade: when nothing was found or the fast path was weak —
    // never on a Discogs-only first pass (MB gets that album on its next pass).
    const needMb = !discogsDone && (fetched.length === 0 || fastPathWeak);
    if (!pinned && needMb) {
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
      // are not impossible (spec §10.3 budget: cap lookups per album; the
      // fast-path lookup already spent one).
      const budget = fastPathWeak ? MAX_LOOKUPS_PER_ALBUM - 1 : MAX_LOOKUPS_PER_ALBUM;
      const plausible = found
        .filter((c) => c.release.id !== embedded.albumMbid)
        .filter((c) => !c.release.tracks?.length || Math.abs(c.release.tracks.length - tracks.length) <= 5)
        .slice(0, budget);
      for (const cand of plausible) {
        take(await mbRelease(ctx, p, cand.release.id), 'mb_search');
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

  // IDN-1c (MB-first tiers): Discogs when MB found nothing or nothing strong;
  // MB candidates are still decided below.
  if (!pinned && !discogsDone) {
    const mbBest = fetched.length ? scoreCandidates(local, fetched.map(toScorable))[0] : undefined;
    if (!mbBest || mbBest.distance > MATCHING_THRESHOLDS.strong) await discogsPass();
  }

  // A Discogs-only pass that settled nothing leaves the album pending for its
  // MusicBrainz pass (identify_attempts ≥ 1 → the sweep sends it MB-first);
  // whatever Discogs found stays as candidates for the album page.
  const discogsLater = async (scoredCount: number, best: number | undefined) => {
    await ctx.db.update(localAlbums)
      .set({ identifyReason: 'discogs_pass', updatedAt: new Date() })
      .where(eq(localAlbums.id, album.id));
    ctx.logger.info({ album: album.titleGuess, candidates: scoredCount, best }, 'identify: discogs pass, MusicBrainz later');
  };

  if (fetched.length === 0) {
    if (discogsDone) { await discogsLater(0, undefined); return; }
    await giveUp('no_candidates');
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
    const source: CandidateSource = sourceOf.get(s.id) ?? (s.source === 'discogs' ? 'discogs_search' : 'mb_search');
    await ctx.db.insert(matchCandidates).values({
      localAlbumId: album.id,
      releaseId: relDb,
      distance: s.distance.toFixed(4),
      breakdown: s.breakdown,
      source,
    });
  }

  const goLive = async (
    releaseDb: string, status: 'auto' | 'confirmed', decidedBy: 'system' | 'user',
    distance: number, reason: string, source: CandidateSource | null,
  ) => {
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
      source,
    });
    const rgRow = await ctx.db
      .select({ rgId: releases.releaseGroupId })
      .from(releases).where(eq(releases.id, releaseDb)).limit(1);
    await ctx.db.update(localAlbums)
      .set({
        state: 'matched',
        releaseId: releaseDb,
        releaseGroupId: rgRow[0]?.rgId ?? null,
        identifyReason: null,
        identifiedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(localAlbums.id, album.id));
    await notifyQueueChanged(ctx, album.libraryId, album.id, 'matched');
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
      data.pinnedMbid ? 'manual MBID entry (IDN-6)' : 'manual Discogs entry (IDN-6)',
      data.pinnedMbid ? 'user_mbid' : 'user_discogs');
    return;
  }

  // IDN-5: accept on fingerprint evidence before the tag-based decision.
  const viaFingerprint = scored
    .filter((s) => sourceOf.get(s.id) === 'acoustid' && acceptedByFingerprint(s))
    .sort((a, b) => (data.acoustidCoverage?.[b.id] ?? 0) - (data.acoustidCoverage?.[a.id] ?? 0) || a.distance - b.distance)[0];
  const viaFingerprintDb = viaFingerprint ? releaseDbIds.get(viaFingerprint.id) : undefined;
  if (viaFingerprint && viaFingerprintDb) {
    const cov = Math.round((data.acoustidCoverage?.[viaFingerprint.id] ?? 0) * 100);
    ctx.logger.info({ album: album.titleGuess, coverage: cov, distance: viaFingerprint.distance }, 'identify: acoustid auto-accept');
    await goLive(viaFingerprintDb, 'auto', 'system', viaFingerprint.distance,
      `acoustid auto-accept: ${cov}% of tracks fingerprint-matched, ${viaFingerprint.tracks?.length ?? 0} vs ${local.tracks.length} tracks (distance ${viaFingerprint.distance.toFixed(4)})`,
      'acoustid');
    return;
  }

  // Discogs-only first pass: settle only what the decision would accept.
  if (discogsDone && !bestIsAcceptable()) {
    await discogsLater(scored.length, scored[0]?.distance);
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
    await goLive(bestDb, 'auto', 'system', best.distance, `auto-accept: distance ${best.distance.toFixed(4)} (${best.source})`,
      sourceOf.get(best.id) ?? null);
  } else if (best && best.distance <= MATCHING_THRESHOLDS.medium) {
    // Owner chip rule (2026-09-05): no reds + ≥3 greens auto-accepts even in
    // the review band; fewest yellows wins. Mirrors hand-review outcomes.
    const inBand = scored.filter((c) => c.distance <= MATCHING_THRESHOLDS.medium);
    const pick = pickByChipRule(inBand.map((c) => ({ breakdown: c.breakdown, distance: c.distance })));
    const chosen = pick >= 0 ? inBand[pick] : undefined;
    const chosenDb = chosen ? releaseDbIds.get(chosen.id) : undefined;
    if (chosen && chosenDb) {
      const cc = chipCounts(chosen.breakdown);
      await goLive(chosenDb, 'auto', 'system', chosen.distance,
        `chip-rule auto-accept: ${cc.greens} green, ${cc.yellows} yellow, 0 red (distance ${chosen.distance.toFixed(4)})`,
        sourceOf.get(chosen.id) ?? null);
      return;
    }
    // Owner policy (2026-09-05): the top candidate in the band is what the
    // owner accepts by hand anyway — take it. Tightened 2026-09-09 (XO-379,
    // after a one-CD folder auto-took a 2-CD edition at 0.2488 with 2 reds):
    // nothing red, and no more media than the local cluster has discs.
    if (best && bestDb) {
      const cc2 = chipCounts(best.breakdown);
      const mediaCount = fetched.find((r) => r.id === best.id)?.mediaList?.length ?? 0;
      const localDiscs = new Set(tracks.map((t) => t.discNo ?? 1)).size;
      if (cc2.reds === 0 && (mediaCount === 0 || mediaCount <= localDiscs)) {
        await goLive(bestDb, 'auto', 'system', best.distance,
          `first-candidate auto-accept: distance ${best.distance.toFixed(4)} (${cc2.greens} green, ${cc2.yellows} yellow, 0 red)`,
          sourceOf.get(best.id) ?? null);
        return;
      }
      ctx.logger.info({ album: album.titleGuess, distance: best.distance, reds: cc2.reds, mediaCount, localDiscs }, 'identify: top candidate held for review');
    }
    await giveUp('ambiguous');
  } else {
    await giveUp('weak_candidates');
  }
}

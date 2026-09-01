import { and, eq, inArray } from 'drizzle-orm';
import {
  albumMatches, audioFiles, canonicalTracks, localAlbums, localTracks,
  matchCandidates, releaseGroups, releases,
} from '@liner/db';
import {
  MusicBrainzProvider, scoreCandidates, MATCHING_THRESHOLDS,
} from '@liner/core';
import type { WorkerContext } from '../lib/context.js';

export interface IdentifyAlbumJobData {
  localAlbumId: string;
  /** re-run even when state is not pending/unidentified */
  force?: boolean;
}

/** MusicBrainz allows ~1 req/s. A module-level pacer serialises every MB call
 * this worker makes, regardless of job concurrency. */
let mbChain: Promise<void> = Promise.resolve();
let mbCooldownUntil = 0;
const MB_INTERVAL_MS = 1100;
const MB_503_COOLDOWN_MS = 60_000;
function paced<T>(fn: () => Promise<T>): Promise<T> {
  const run = mbChain.then(async () => {
    const coolWait = mbCooldownUntil - Date.now();
    if (coolWait > 0) await new Promise((r) => setTimeout(r, coolWait));
    const started = Date.now();
    try {
      return await fn();
    } catch (err) {
      // MB 503s every request while over the limit; hammering it during the
      // penalty window extends it (spec §10.2.2). Hold the whole chain.
      if (/503|rate limit/i.test((err as Error).message)) {
        mbCooldownUntil = Date.now() + MB_503_COOLDOWN_MS;
      }
      throw err;
    } finally {
      const wait = MB_INTERVAL_MS - (Date.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  });
  mbChain = run.then(() => undefined, () => undefined);
  return run;
}

let mb: MusicBrainzProvider | null = null;
function provider(contact: string): MusicBrainzProvider {
  if (!mb) mb = new MusicBrainzProvider(`Liner/0.1 (+${contact})`);
  return mb;
}

const MAX_LOOKUPS_PER_ALBUM = 3;

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

export async function identifyAlbumJob(ctx: WorkerContext, data: IdentifyAlbumJobData): Promise<void> {
  const albumRows = await ctx.db
    .select()
    .from(localAlbums)
    .where(eq(localAlbums.id, data.localAlbumId))
    .limit(1);
  const album = albumRows[0];
  if (!album) return;
  if (!data.force && album.state !== 'pending' && album.state !== 'unidentified') return;
  if (!album.titleGuess || !album.artistGuess) {
    await ctx.db.update(localAlbums)
      .set({ state: 'unidentified', updatedAt: new Date() })
      .where(eq(localAlbums.id, album.id));
    return;
  }

  const contact = await contactString(ctx, album.libraryId);
  if (!contact) throw new Error('no contact string configured (PLT-4); refusing MusicBrainz calls');

  const tracks = await ctx.db
    .select()
    .from(localTracks)
    .where(eq(localTracks.localAlbumId, album.id));
  if (tracks.length === 0) return;

  // Embedded IDs from the first track's file tags (IDN-1a).
  const fileRows = await ctx.db
    .select({ tagsRaw: audioFiles.tagsRaw })
    .from(audioFiles)
    .where(inArray(audioFiles.id, tracks.slice(0, 3).map((t) => t.audioFileId)));
  let embedded: EmbeddedIds = {};
  for (const f of fileRows) {
    embedded = { ...embeddedIdsOf(f.tagsRaw), ...embedded };
  }

  const local = {
    artist: album.artistGuess,
    title: album.titleGuess,
    tracks: tracks
      .sort((a, b) => (a.discNo ?? 1) - (b.discNo ?? 1) || (a.trackNo ?? 0) - (b.trackNo ?? 0))
      .map((t, i) => ({
        title: t.titleGuess ?? '',
        ...(t.artistGuess ? { artist: t.artistGuess } : {}),
        duration: (t.durationMs ?? 0) / 1000,
        index: i,
      })),
    ...(album.yearGuess ? { year: album.yearGuess } : {}),
    ...(embedded.albumMbid ? { embeddedMbId: embedded.albumMbid } : {}),
    ...(embedded.rgMbid ? { embeddedMbRgId: embedded.rgMbid } : {}),
    ...(embedded.barcode ? { barcode: embedded.barcode } : {}),
  };

  const p = provider(contact);
  const ctxCall = { priority: 'background' as const };

  // Candidate generation (IDN-1): embedded MBID first, then search.
  const fetched: Awaited<ReturnType<typeof p.getRelease>>[] = [];
  try {
    if (embedded.albumMbid) {
      const rel = await paced(() => p.getRelease(embedded.albumMbid as string, ctxCall));
      if (rel) fetched.push(rel);
    }
    if (fetched.length === 0) {
      const found = await paced(() => p.searchReleases({
        albumTitle: album.titleGuess as string,
        artistName: album.artistGuess as string,
        trackCount: tracks.length,
        ...(embedded.barcode ? { barcode: embedded.barcode } : {}),
      }, ctxCall));
      // Fetch full tracklists for the top few candidates whose track counts
      // are not impossible (spec §10.3 budget: cap lookups per album).
      const plausible = found
        .filter((c) => !c.release.tracks?.length || Math.abs(c.release.tracks.length - tracks.length) <= 5)
        .slice(0, MAX_LOOKUPS_PER_ALBUM);
      for (const cand of plausible) {
        const rel = await paced(() => p.getRelease(cand.release.id, ctxCall));
        if (rel) fetched.push(rel);
      }
    }
  } catch (err) {
    ctx.logger.warn({ album: album.titleGuess, err: (err as Error).message }, 'identify: provider error');
    throw err; // pg-boss retry with backoff
  }

  if (fetched.length === 0) {
    await ctx.db.update(localAlbums)
      .set({ state: 'unidentified', updatedAt: new Date() })
      .where(eq(localAlbums.id, album.id));
    return;
  }

  // Score (IDN-2). Core expects seconds and 0-based indices.
  const scored = scoreCandidates(
    local,
    fetched.map((r) => ({
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
      source: 'musicbrainz' as const,
    })),
  );

  // Persist canonical entities + candidates.
  const releaseDbIds = new Map<string, string>();
  for (const r of fetched) {
    releaseDbIds.set(r.id, await upsertCanonical(ctx, r));
  }
  await ctx.db.delete(matchCandidates).where(eq(matchCandidates.localAlbumId, album.id));
  for (const s of scored) {
    const relDb = releaseDbIds.get(s.id);
    if (!relDb) continue;
    await ctx.db.insert(matchCandidates).values({
      localAlbumId: album.id,
      releaseId: relDb,
      distance: s.distance.toFixed(4),
      breakdown: s.breakdown,
      source: embedded.albumMbid ? 'mbid' : 'mb_search',
    });
  }

  // Decide (IDN-3).
  const best = scored[0];
  const second = scored[1];
  const bestDb = best ? releaseDbIds.get(best.id) : undefined;
  const gapDemoted = best && second && second.distance - best.distance < MATCHING_THRESHOLDS.recGapThresh
    && second.distance <= MATCHING_THRESHOLDS.medium && best.distance > 0;
  const trackParity = best ? (best.tracks?.length ?? 0) === local.tracks.length : false;

  if (best && bestDb && best.distance <= MATCHING_THRESHOLDS.strong && trackParity && !gapDemoted) {
    await ctx.db.insert(albumMatches).values({
      libraryId: album.libraryId,
      localAlbumId: album.id,
      releaseId: bestDb,
      distance: best.distance.toFixed(4),
      status: 'auto',
      decidedBy: 'system',
      reason: `auto-accept: distance ${best.distance.toFixed(4)}`,
    });
    const rgRow = await ctx.db
      .select({ rgId: releases.releaseGroupId })
      .from(releases).where(eq(releases.id, bestDb)).limit(1);
    await ctx.db.update(localAlbums)
      .set({
        state: 'matched',
        releaseId: bestDb,
        releaseGroupId: rgRow[0]?.rgId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(localAlbums.id, album.id));
  } else if (best && best.distance <= MATCHING_THRESHOLDS.medium) {
    await ctx.db.update(localAlbums)
      .set({ state: 'needs_review', updatedAt: new Date() })
      .where(eq(localAlbums.id, album.id));
  } else {
    await ctx.db.update(localAlbums)
      .set({ state: 'unidentified', updatedAt: new Date() })
      .where(eq(localAlbums.id, album.id));
  }
}

async function contactString(ctx: WorkerContext, libraryId: string): Promise<string | null> {
  const rows = await ctx.sql`
    select settings->>'contactString' as c from libraries where id = ${libraryId}` as unknown as { c: string | null }[];
  return rows[0]?.c ?? null;
}

/** Minimal ENR-1: release group + release + canonical tracks. Returns the
 * releases.id (db uuid) for the MB release. */
async function upsertCanonical(
  ctx: WorkerContext,
  r: { id: string; releaseGroupId: string; title: string; artists: string[]; tracks?: { title: string; artists: string[]; duration: number; position: number; mediumNumber: number; recordingId?: string | undefined }[] | undefined; year?: number | undefined; date?: string | undefined; country?: string | undefined; barcode?: string | undefined; status?: string | undefined; label?: string | undefined },
): Promise<string> {
  const rgIns = await ctx.db.insert(releaseGroups)
    .values({
      mbid: r.releaseGroupId,
      title: r.title,
      artistCredit: r.artists,
      fetchedAt: new Date(),
    })
    .onConflictDoUpdate({ target: releaseGroups.mbid, set: { fetchedAt: new Date() } })
    .returning({ id: releaseGroups.id });
  const rgId = rgIns[0]?.id;
  if (!rgId) throw new Error('release_groups upsert returned no row');

  const relIns = await ctx.db.insert(releases)
    .values({
      releaseGroupId: rgId,
      mbid: r.id,
      title: r.title,
      status: r.status ?? null,
      date: r.date ?? (r.year ? `${r.year}-01-01` : null),
      country: r.country && r.country.length === 2 ? r.country : null,
      barcode: r.barcode ?? null,
      labels: r.label ? [{ name: r.label }] : [],
      trackCount: r.tracks?.length ?? null,
      sourceOfTruth: 'musicbrainz',
      fetchedAt: new Date(),
    })
    .onConflictDoUpdate({ target: releases.mbid, set: { fetchedAt: new Date() } })
    .returning({ id: releases.id });
  const relId = relIns[0]?.id;
  if (!relId) throw new Error('releases upsert returned no row');

  if (r.tracks && r.tracks.length > 0) {
    await ctx.db.delete(canonicalTracks).where(eq(canonicalTracks.releaseId, relId));
    await ctx.db.insert(canonicalTracks).values(
      r.tracks.map((t) => ({
        releaseId: relId,
        mediumNo: t.mediumNumber,
        position: t.position,
        title: t.title.slice(0, 255),
        artistCredit: t.artists,
        lengthMs: Math.round(t.duration || 0),
      })),
    );
  }
  return relId;
}

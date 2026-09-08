import { rankAcoustIdReleases, AcoustIdError, type AcoustIdRecording } from '@liner/core';
import type { WorkerContext } from '../lib/context.js';
import { fingerprintHash } from '../lib/fingerprint.js';
import { openCooldown } from '../lib/pacer.js';
import { cached, cacheKey } from '../lib/providerCache.js';
import { acoustidCall, getProviders, libraryProviderSettings } from '../lib/providers.js';

export interface AcoustidLookupJobData {
  localAlbumId: string;
}

/** AcoustID's own data changes slowly; a fingerprint's answer is good for a month. */
const LOOKUP_TTL_S = 30 * 24 * 3600;
/** Releases that explain at least this share of the album's tracks become candidates (a one-file cue image: 1/1). */
const MIN_COVERAGE = 0.5;
const MAX_CANDIDATES = 3;
/** Bulk/triage tier (api/lib/identifyRequests.ts): ahead of the sweep, behind an owner's click. */
const IDENTIFY_PRIORITY = 50;

interface TrackRow {
  audio_file_id: string;
  fingerprint: string;
  fingerprint_duration: number | null;
}

/**
 * IDN-5, identify-worker half: one AcoustID lookup per fingerprinted file
 * (cached by fingerprint hash, paced at 3 req/s), rank the releases the
 * tracks point at, and hand the best few to identify.album as
 * `acoustidMbids` — the identify job fetches, scores and decides like it
 * does for any other candidate source.
 */
export async function acoustidLookupJob(ctx: WorkerContext, data: AcoustidLookupJobData): Promise<void> {
  const [album] = (await ctx.sql`select id, library_id, state from local_albums where id = ${data.localAlbumId}`) as unknown as Array<{ id: string; library_id: string; state: string }>;
  if (!album) return;
  const settings = await libraryProviderSettings(ctx, album.library_id);
  const providers = getProviders(settings);
  if (!providers.acoustid) {
    ctx.logger.warn({ localAlbumId: album.id }, 'acoustid.lookup: no AcoustID key for this library');
    await ctx.sql`update local_albums set fingerprinted_at = now(), acoustid_result = 'no_key' where id = ${album.id}`;
    return;
  }

  const tracks = (await ctx.sql`
    select distinct af.id as audio_file_id, af.fingerprint, af.fingerprint_duration
    from local_tracks lt join audio_files af on af.id = lt.audio_file_id
    where lt.local_album_id = ${album.id} and af.fingerprint is not null`) as unknown as TrackRow[];
  if (tracks.length === 0) {
    await ctx.sql`update local_albums set fingerprinted_at = now(), acoustid_result = 'no_fingerprints' where id = ${album.id}`;
    return;
  }

  const perTrack: AcoustIdRecording[][] = [];
  for (const t of tracks) {
    const key = cacheKey('acoustid-lookup', fingerprintHash(t.fingerprint));
    try {
      const recs = await cached<AcoustIdRecording[]>(ctx.sql, 'acoustid', key, LOOKUP_TTL_S, () =>
        acoustidCall(ctx, () => providers.acoustid!.lookup(t.fingerprint, t.fingerprint_duration ?? 120)));
      perTrack.push(recs);
    } catch (err) {
      if (err instanceof AcoustIdError && err.isRateLimit) {
        await openCooldown(ctx.sql, 'acoustid', 60_000, err.message);
        throw err; // pg-boss retries the album after the cooldown
      }
      ctx.logger.warn({ localAlbumId: album.id, err: (err as Error).message }, 'acoustid.lookup: track lookup failed');
      perTrack.push([]);
    }
  }

  const ranked = rankAcoustIdReleases(perTrack).filter((r) => r.coverage >= MIN_COVERAGE).slice(0, MAX_CANDIDATES);
  const mbids = ranked.map((r) => r.mbid);
  ctx.logger.info({
    localAlbumId: album.id, tracks: tracks.length, withHits: perTrack.filter((p) => p.length > 0).length,
    candidates: ranked.map((r) => ({ mbid: r.mbid, title: r.title, coverage: Number(r.coverage.toFixed(2)), score: Number(r.score.toFixed(2)) })),
  }, 'acoustid.lookup done');

  if (mbids.length === 0) {
    await ctx.sql`update local_albums set fingerprinted_at = now(), acoustid_result = 'no_candidates' where id = ${album.id}`;
    return;
  }
  await ctx.sql`update local_albums set fingerprinted_at = now(), acoustid_result = 'candidates' where id = ${album.id}`;

  // The identify queue is 'stately' with one job per album: fold the MBIDs into
  // a job that is already waiting (a plain send would be deduped and lose them),
  // otherwise queue a fresh one at the triage tier.
  const payload = JSON.stringify({ acoustidMbids: mbids, force: true });
  const updated = (await ctx.sql`
    update pgboss.job set data = data || ${payload}::jsonb, priority = greatest(priority, ${IDENTIFY_PRIORITY})
    where name = 'identify.album' and singleton_key = ${'identify:' + album.id} and state = 'created'
    returning id`) as unknown as unknown[];
  if (updated.length === 0) {
    await ctx.boss.send('identify.album', { localAlbumId: album.id, force: true, acoustidMbids: mbids }, {
      singletonKey: `identify:${album.id}`, priority: IDENTIFY_PRIORITY, retryLimit: 3, retryDelay: 60, retryBackoff: true,
    });
  }
}

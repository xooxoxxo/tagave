/**
 * Review matches › "Not listed?": the owner pastes a MusicBrainz or Discogs
 * release. Fetch it through the same cached, paced provider calls identify
 * uses, score it against the album exactly like a searched candidate, and add
 * it to the album's candidates. Nothing is decided: the album stays where it
 * is and the owner accepts (or not) on the review screen.
 *
 * The job's return value is its output (pg-boss), which the API hands to the
 * screen: the new candidate's id, or a sentence saying why there is none.
 */
import { and, eq } from 'drizzle-orm';
import { localAlbums, localTracks, matchCandidates } from '@tagave/db';
import { scoreCandidates, MAX_ALIGN_TRACKS, type CanonicalRelease } from '@tagave/core';
import type { WorkerContext } from '../lib/context.js';
import { libraryProviderSettings, getProviders } from '../lib/providers.js';
import { discogsMaster, discogsRelease, localViewOf, mbRelease, persistFetched, toScorable } from './identifyAlbum.js';

export type EditionTarget =
  | { source: 'musicbrainz'; mbid: string }
  | { source: 'discogs'; kind: 'release' | 'master'; id: number };

export interface AddEditionJobData {
  localAlbumId: string;
  target: EditionTarget;
}

export type AddEditionResult =
  | { ok: true; candidateId: string; releaseId: string; distance: number; added: boolean }
  | { ok: false; message: string };

const status = (err: unknown) => (err as { status?: number } | null)?.status;

export async function addEditionJob(ctx: WorkerContext, data: AddEditionJobData): Promise<AddEditionResult> {
  const album = (await ctx.db.select().from(localAlbums).where(eq(localAlbums.id, data.localAlbumId)).limit(1))[0];
  if (!album) return { ok: false, message: 'This album is gone (merged or regrouped). Open the next one.' };
  const tracks = await ctx.db.select().from(localTracks).where(eq(localTracks.localAlbumId, album.id));
  if (tracks.length === 0) return { ok: false, message: 'This album has no tracks to compare the release with.' };

  const p = getProviders(await libraryProviderSettings(ctx, album.libraryId));
  const t = data.target;
  let release: CanonicalRelease;
  try {
    if (t.source === 'musicbrainz') {
      release = await mbRelease(ctx, p, t.mbid);
    } else {
      let id = t.id;
      if (t.kind === 'master') {
        const master = await discogsMaster(ctx, p, t.id);
        if (!master.mainReleaseId) return { ok: false, message: 'This Discogs master names no main release. Paste one of its release pages instead.' };
        id = master.mainReleaseId;
      }
      release = await discogsRelease(ctx, p, id);
    }
  } catch (err) {
    if (status(err) === 404) {
      return {
        ok: false,
        message: t.source === 'musicbrainz'
          ? 'MusicBrainz has no release with this ID. If it is a release group, open it and paste one of its releases.'
          : `Discogs has no ${t.kind} with this ID (${t.id}).`,
      };
    }
    throw err; // provider trouble: pg-boss retries, the screen keeps waiting
  }
  if ((release.tracks?.length ?? 0) > MAX_ALIGN_TRACKS) {
    return { ok: false, message: 'That release has too many tracks to compare with your files.' };
  }

  const { local } = await localViewOf(ctx, album, tracks);
  const scored = scoreCandidates(local, [toScorable(release)])[0]!;
  const { releaseId } = await persistFetched(ctx, release);

  // One candidate per release: pasting a listed (or excluded) edition again
  // refreshes its score and brings it back instead of adding a twin.
  const existing = await ctx.db.select({ id: matchCandidates.id }).from(matchCandidates)
    .where(and(eq(matchCandidates.localAlbumId, album.id), eq(matchCandidates.releaseId, releaseId))).limit(1);
  const distance = scored.distance.toFixed(4);
  if (existing[0]) {
    await ctx.db.update(matchCandidates)
      .set({ distance, breakdown: scored.breakdown, excluded: false })
      .where(eq(matchCandidates.id, existing[0].id));
    return { ok: true, candidateId: existing[0].id, releaseId, distance: scored.distance, added: false };
  }
  const inserted = await ctx.db.insert(matchCandidates).values({
    localAlbumId: album.id,
    releaseId,
    distance,
    breakdown: scored.breakdown,
    source: t.source === 'musicbrainz' ? 'user_mbid' : 'user_discogs',
  }).returning({ id: matchCandidates.id });
  ctx.logger.info({ localAlbumId: album.id, releaseId, distance: scored.distance }, 'edition added by the owner');
  return { ok: true, candidateId: inserted[0]!.id, releaseId, distance: scored.distance, added: true };
}

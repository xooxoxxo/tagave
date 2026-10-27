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
import { eq } from 'drizzle-orm';
import { localAlbums, localTracks } from '@tagave/db';
import { scoreCandidates, buildCandidateEvidence, stableJson, MAX_ALIGN_TRACKS, type CanonicalRelease } from '@tagave/core';
import type { WorkerContext } from '../lib/context.js';
import { libraryProviderSettings, getProviders } from '../lib/providers.js';
import { remoteInputOf, upsertAlbumEvidence } from '../lib/evidenceStore.js';
import { discogsMaster, discogsRelease, localViewOf, mbRelease, persistFetched, toScorable } from './identifyAlbum.js';
import { rebuildAlbumEvidence } from './evidenceBackfill.js';

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

  const { local, albumEvidence } = await localViewOf(ctx, album, tracks);
  const scored = scoreCandidates(local, [toScorable(release)])[0]!;
  const { releaseId } = await persistFetched(ctx, release);
  // The evidence goes with the distance on both paths below: a refreshed
  // score next to stale evidence would pin a decision to facts it never saw.
  // A pasted release has no fingerprint lookup behind it: a new candidate has
  // no AcoustID coverage, and a listed one keeps the coverage its
  // identification measured (the fingerprints did not change).
  const evidence = buildCandidateEvidence(remoteInputOf(release, null), scored, local.tracks.length);

  // One candidate per release: pasting a listed (or excluded) edition again
  // refreshes its score and brings it back instead of adding a twin. A
  // module's suggestion of the same release (source mc:<link>) is never
  // that candidate: its breakdown (mc.key names it for the linked app's
  // retract and revoke) stays as the module wrote it, and the owner's
  // evidence goes in a candidate of its own beside it.
  const distance = scored.distance.toFixed(4);
  const ev = JSON.stringify(evidence);
  const breakdown = JSON.stringify(scored.breakdown);
  const source = t.source === 'musicbrainz' ? 'user_mbid' : 'user_discogs';
  // The candidate and the album evidence it was scored against change together.
  const written = await ctx.sql.begin(async (tx) => {
    // When the album's own side changed since its candidates were scored (its
    // tracks were re-read without a re-identification), their evidence
    // points at tracks the album no longer has: it is dropped here and
    // rebuilt below. Should the rebuild fail, the candidates are left without
    // evidence, which the evidence backfill picks up, never with stale evidence.
    const [prev] = await tx<Array<{ evidence: unknown }>>`select evidence from album_evidence where local_album_id = ${album.id}`;
    const albumChanged = !prev || stableJson(prev.evidence) !== stableJson(albumEvidence);
    await upsertAlbumEvidence(tx, album.id, albumEvidence);
    const [existing] = await tx<Array<{ id: string }>>`
      select id from match_candidates
       where local_album_id = ${album.id} and release_id = ${releaseId} and source not like 'mc:%' limit 1`;
    let id: string;
    let added: boolean;
    if (existing) {
      await tx`update match_candidates
                  set distance = ${distance}::numeric, breakdown = ${breakdown}::text::jsonb, excluded = false, evidence = ${ev}::text::jsonb
                where id = ${existing.id}`;
      id = existing.id;
      added = false;
    } else {
      const [inserted] = await tx<Array<{ id: string }>>`
        insert into match_candidates (local_album_id, release_id, distance, breakdown, source, evidence, acoustid_coverage)
        values (${album.id}, ${releaseId}, ${distance}::numeric, ${breakdown}::text::jsonb, ${source}, ${ev}::text::jsonb, null)
        returning id`;
      id = inserted!.id;
      added = true;
    }
    if (albumChanged) {
      await tx`update match_candidates set evidence = null
                where local_album_id = ${album.id} and source not like 'mc:%' and id <> ${id} and evidence is not null`;
    }
    return { id, added, albumChanged };
  });
  if (written.albumChanged) {
    try {
      // the other candidates, re-scored offline from their stored releases
      await rebuildAlbumEvidence(ctx, album.id, { except: written.id, incomplete: 'clear' });
    } catch (err) {
      // The pasted edition is in; the owner's screen gets it. The others stay
      // without evidence until the backfill rebuilds them.
      ctx.logger.error({ localAlbumId: album.id, err: (err as Error).message }, 'edition added: rebuilding the other candidates\' evidence failed');
    }
  }
  if (!written.added) {
    return { ok: true, candidateId: written.id, releaseId, distance: scored.distance, added: false };
  }
  ctx.logger.info({ localAlbumId: album.id, releaseId, distance: scored.distance }, 'edition added by the owner');
  return { ok: true, candidateId: written.id, releaseId, distance: scored.distance, added: true };
}

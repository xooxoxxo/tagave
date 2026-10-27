/**
 * Undo of an accept batch (decider.accept, mode 'undo'): per album, in its
 * own transaction, put back what the accept replaced (state, identify
 * reason, release, the earlier live match with its own provenance) and clear
 * the track links written since. An album the owner touched after the
 * accept (a different state or release, a newer decision, a field lock, a
 * tag plan over its files) is left as it is and listed with the reason.
 * What linked apps already pulled and tag plans already applied cannot be
 * undone; the accept dialog says so.
 *
 * Locks, in the accept's order: the item row, then the album row (for no key
 * update), then the album's match rows. Downstream work is sent after each
 * chunk is written: a cover look-up again (without the wrong release's
 * stored source) for albums whose cover came from a provider, one queue
 * notice per chunk, and one gaps recompute at the end. Restartable: items
 * keep their status, so a retry carries on with what is still accepted.
 */
import type postgres from 'postgres';
import { batchCounts, getBatch, itemsWithStatus, transitionBatch, type BatchItemRow, type LeftReason } from '@tagave/db';
import type { WorkerContext } from '../lib/context.js';
import { artRefreshKey } from './artFetch.js';
import { notifyQueueChanged, reportProgress } from './progress.js';
import { ACCEPT_CHUNK, type BatchAttempt, type BatchRunResult } from './deciderAccept.js';

type Outcome = { status: 'undone'; providerCover: boolean } | { status: 'left'; reason: LeftReason } | { status: 'done' };

/** Why the album is left as it is, or null when nobody touched it since the accept. */
async function touchedSince(
  tx: postgres.TransactionSql<any>, item: BatchItemRow, album: { state: string; release_id: string | null } | undefined,
): Promise<LeftReason | null> {
  if (!album) return 'gone';
  if (album.state !== 'matched' || album.release_id !== item.releaseId) return 'state_changed';
  // the accept's own time, read from the item row, so no precision is lost on the way
  const since = tx`(select accepted_at from decider_batch_items where id = ${item.id})`;
  // A person's decision always wins over an undo: a newer decision row, or
  // the owner endorsing the batch's own match in place (any edition).
  const [mine] = await tx<Array<{ decided_kind: string; decided_by: string }>>`
    select decided_kind, decided_by from album_matches where id = ${item.matchId}::uuid for update`;
  if (mine && (mine.decided_kind === 'user' || mine.decided_by === 'user')) return 'newer_decision';
  const newer = await tx`
    select 1 from album_matches
     where local_album_id = ${item.localAlbumId} and id is distinct from ${item.matchId}::uuid and created_at > ${since}
     limit 1`;
  if (newer.length) return 'newer_decision';
  // a track lock is keyed by the local track or by its file
  const locks = await tx`
    select 1 from field_locks fl
     where fl.created_at > ${since}
       and ((fl.scope = 'album' and fl.scope_id = ${item.localAlbumId})
            or (fl.scope = 'track' and exists (select 1 from local_tracks lt
                                                where lt.local_album_id = ${item.localAlbumId}
                                                  and (lt.id = fl.scope_id or lt.audio_file_id = fl.scope_id))))
     limit 1`;
  if (locks.length) return 'locks';
  const plans = await tx`
    select 1 from tag_plan_items tpi
      join tag_plans tp on tp.id = tpi.tag_plan_id
      join local_tracks lt on lt.audio_file_id = tpi.audio_file_id
     where lt.local_album_id = ${item.localAlbumId} and tp.created_at > ${since}
     limit 1`;
  if (plans.length) return 'tag_plan';
  return null;
}

async function undoItem(ctx: WorkerContext, libraryId: string, item: BatchItemRow): Promise<Outcome> {
  return ctx.sql.begin(async (tx) => {
    // The item first: a second run of the same batch waits here and then finds it handled.
    const [own] = await tx<Array<{ status: string }>>`select status from decider_batch_items where id = ${item.id} for update`;
    if (!own || own.status !== 'accepted') return { status: 'done' } as Outcome;
    const [album] = await tx<Array<{ state: string; release_id: string | null }>>`
      select state, release_id from local_albums
       where id = ${item.localAlbumId} and library_id = ${libraryId} for no key update`;
    const reason = await touchedSince(tx, item, album);
    if (reason) {
      await tx`update decider_batch_items set status = 'left', skip_reason = ${reason} where id = ${item.id}`;
      return { status: 'left', reason } as Outcome;
    }
    // The batch's match goes first (one live match per album). Its row may
    // be gone (deleting a release deletes its matches); the album is put
    // back all the same, since nobody decided anything about it since.
    await tx`update album_matches set status = 'rejected'
              where local_album_id = ${item.localAlbumId} and status in ('auto', 'confirmed')`;
    // The match the accept replaced comes back live as it was: who decided
    // it, its probability and its reason stay its own. Gone with its
    // release, nothing comes back.
    if (item.priorMatchId && item.priorMatchStatus) {
      await tx`update album_matches set status = ${item.priorMatchStatus}, reason = coalesce(${item.priorMatchReason}::text, reason)
                where id = ${item.priorMatchId} and status = 'rejected'`;
    }
    // The state change makes Music Connections log the album's identity, for
    // the accepted release group and for the restored one. A prior release
    // deleted since is not pointed at again.
    await tx`
      update local_albums
         set state = ${item.priorState ?? 'needs_review'}, identify_reason = ${item.priorIdentifyReason},
             release_id = (select id from releases where id = ${item.priorReleaseId}::uuid),
             release_group_id = case when exists (select 1 from releases where id = ${item.priorReleaseId}::uuid)
                                     then ${item.priorReleaseGroupId}::uuid end,
             identified_at = ${item.priorIdentifiedAt ? item.priorIdentifiedAt.toISOString() : null}::timestamptz,
             tracks_linked_at = null, updated_at = now()
       where id = ${item.localAlbumId}`;
    await tx`update local_tracks set canonical_track_id = null, recording_id = null, match_distance = null, state = 'unmatched'
              where local_album_id = ${item.localAlbumId}`;
    await tx`update decider_batch_items set status = 'undone', undone_at = now() where id = ${item.id}`;
    const [img] = await tx<Array<{ origin: string }>>`
      select origin from images where local_album_id = ${item.localAlbumId} and kind = 'front' limit 1`;
    return { status: 'undone', providerCover: img?.origin === 'provider' } as Outcome;
  });
}

const sum = (r: Record<string, number>): number => Object.values(r).reduce((a, b) => a + b, 0);

/**
 * Undoes what is still accepted in the batch. Starts from accepted, failed
 * (the chunks before the failure stay accepted) or undoing (asked for, or a
 * run that stopped); anything else does nothing. Every batch state change is
 * conditional. A failed run marks its own activity row failed; the batch
 * stays undoing while a retry follows, and fails on the last attempt.
 */
export async function runUndoBatch(ctx: WorkerContext, batchId: string, attempt: BatchAttempt = {}): Promise<BatchRunResult> {
  const result: BatchRunResult = { accepted: 0, undone: 0, skipped: {}, left: {} };
  const batch = await getBatch(ctx.sql, batchId);
  if (!batch || !(await transitionBatch(ctx.sql, batchId, ['accepted', 'failed', 'undoing'], 'undoing'))) return result;
  // queued without a request (requestUndo stamps who asked): keep at least when
  await ctx.sql`update decider_batches set undo_requested_at = coalesce(undo_requested_at, now()) where id = ${batchId}`;
  const total = (await batchCounts(ctx.sql, batchId)).accepted;
  const progress = { libraryId: batch.libraryId, type: 'decider.accept', subjectType: 'batch', subjectId: batchId };
  const done = () => result.undone + sum(result.left);
  let runId: string | null = null;
  try {
    let movedOn = false;
    for (;;) {
      const [now] = await ctx.sql<Array<{ state: string }>>`select state from decider_batches where id = ${batchId}`;
      if (now?.state !== 'undoing') { movedOn = true; break; }
      const chunk = await itemsWithStatus(ctx.sql, batchId, 'accepted', ACCEPT_CHUNK);
      if (chunk.length === 0) break;
      const covers: string[] = [];
      let undoneHere = 0;
      for (const item of chunk) {
        const o = await undoItem(ctx, batch.libraryId, item);
        if (o.status === 'undone') {
          undoneHere += 1;
          if (o.providerCover) covers.push(item.localAlbumId);
        } else if (o.status === 'left') {
          result.left[o.reason] = (result.left[o.reason] ?? 0) + 1;
        }
      }
      result.undone += undoneHere;
      // after the chunk is written: a cover found for the wrong release is looked up again
      for (const id of covers) {
        await ctx.boss.send('art.fetch', { localAlbumId: id, refresh: true, reselect: true }, { singletonKey: artRefreshKey(id) });
      }
      if (undoneHere > 0) await notifyQueueChanged(ctx, batch.libraryId, null, 'needs_review');
      runId = await reportProgress(ctx, runId, { ...progress, state: 'running', done: done(), total });
    }
    if (movedOn) {
      await reportProgress(ctx, runId, { ...progress, state: 'cancelled', done: done(), total, message: 'Stopped: the batch was moved on' });
      return result;
    }
    // the whole batch's counts, so a run that resumed another still says what the undo did
    const counts = await batchCounts(ctx.sql, batchId);
    // before the state change, as the accept does: a crash between the two still leaves it queued
    if (counts.undone > 0) {
      await ctx.boss.send('gaps.recompute', { libraryId: batch.libraryId }, { singletonKey: `gaps:${batch.libraryId}` });
    }
    const message = `${counts.undone} undone, ${counts.left} left`;
    const finished = await transitionBatch(ctx.sql, batchId, ['undoing'], 'undone', { message });
    await reportProgress(ctx, runId, finished
      ? { ...progress, state: 'completed', done: done(), total, message }
      : { ...progress, state: 'cancelled', done: done(), total, message: 'Stopped: the batch was moved on' });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // best effort: the error that stopped the run is the one to rethrow
    try {
      await reportProgress(ctx, runId, { ...progress, state: 'failed', done: done(), total, error: message });
      if (attempt.lastAttempt ?? true) {
        await transitionBatch(ctx.sql, batchId, ['undoing'], 'failed', { message: `Undo stopped: ${message}` });
      }
    } catch (recordErr) {
      ctx.logger.error({ batchId, err: recordErr instanceof Error ? recordErr.message : String(recordErr) }, 'decider.accept could not record an undo failure');
    }
    throw err;
  }
}

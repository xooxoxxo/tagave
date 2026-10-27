/**
 * decider.accept: accept (or undo, mode 'undo') one batch, in chunks.
 *
 * Each album in its own transaction with the album row locked: still in
 * review, not identified again since the decision (last_identify_at), the
 * release still stored, and, for a model's batch, the same evidence the
 * decision was made on. The accept writes what it replaced onto the item
 * (prior_*) in the same transaction, so the batch can be undone album by
 * album. Downstream work is left to the sweeps that already run (nightly
 * enrichment, the cover and track-link sweeps), so a large batch never
 * floods the shared provider budget; the queue page hears one notice per
 * chunk, after the chunk is written, and gaps are recomputed once at the
 * end. Restartable: items keep their status, so a retry carries on where
 * the last run stopped and accepts nothing twice.
 */
import {
  acceptInTx, assertAcceptInput, batchCounts, getBatch, itemsWithStatus, transitionBatch,
  type AcceptInput, type BatchItemRow, type BatchRow,
} from '@tagave/db';
import type { WorkerContext } from '../lib/context.js';
import { notifyQueueChanged, reportProgress } from './progress.js';
import { currentEvidenceHash } from '../lib/evidenceStore.js';
import { runUndoBatch } from './deciderUndo.js';

export interface DeciderAcceptJobData { batchId: string; mode?: 'accept' | 'undo' }
export interface BatchRunResult { accepted: number; undone: number; skipped: Record<string, number>; left: Record<string, number> }
export const ACCEPT_CHUNK = 50;

/** lastAttempt: no retry follows if this run fails (default true: a direct call has none) */
export interface BatchAttempt { lastAttempt?: boolean }

export async function deciderAcceptJob(ctx: WorkerContext, data: DeciderAcceptJobData, attempt: BatchAttempt = {}): Promise<BatchRunResult> {
  return data.mode === 'undo' ? runUndoBatch(ctx, data.batchId, attempt) : runAcceptBatch(ctx, data.batchId, attempt);
}

type Outcome = { status: 'accepted'; matchId: string } | { status: 'skipped'; reason: string } | { status: 'done' };

function acceptInput(batch: BatchRow, item: BatchItemRow): AcceptInput {
  return {
    libraryId: batch.libraryId, albumId: item.localAlbumId, releaseId: item.releaseId, distance: item.distance, source: item.source,
    reason: item.reason, status: 'auto', decidedBy: 'system', decidedKind: batch.decidedKind,
    // the person column means the person who decided; who ran the batch is on the batch
    decidedByUserId: null, deciderId: batch.deciderId, deciderVersion: batch.deciderVersion,
    probability: item.probability, batchId: batch.id, fromStates: batch.acceptFrom,
  };
}

async function acceptItem(ctx: WorkerContext, batch: BatchRow, item: BatchItemRow): Promise<Outcome> {
  return ctx.sql.begin(async (tx) => {
    // The item first: a second run of the same batch waits here and then
    // finds it handled, instead of re-checking an album this run moved.
    const [mine] = await tx<Array<{ status: string }>>`select status from decider_batch_items where id = ${item.id} for update`;
    if (!mine || mine.status !== 'pending') return { status: 'done' } as Outcome;
    // The album row, locked the way acceptInTx locks it (rows that only
    // reference the album can still be written). The identify time is
    // compared in milliseconds: the expected value went through a JS Date.
    const [album] = await tx<Array<{ state: string; same_identify: boolean }>>`
      select la.state,
             date_trunc('milliseconds', la.last_identify_at) is not distinct from date_trunc('milliseconds', i.expect_last_identify_at) as same_identify
        from local_albums la, decider_batch_items i
       where la.id = ${item.localAlbumId} and la.library_id = ${batch.libraryId} and i.id = ${item.id}
         for no key update of la`;
    let reason: string | null = null;
    if (!album) reason = 'gone';
    else if (!batch.acceptFrom.includes(album.state)) reason = 'state';
    else if (item.expectLastIdentifyAt && !album.same_identify) reason = 'reidentified';
    // compared here, in the accept's own transaction: taking the evidence lock
    // after the album row could deadlock against evidence writes
    else if (batch.decidedKind === 'model' && item.evidenceHash
             && (await currentEvidenceHash(tx, item.localAlbumId)) !== item.evidenceHash) reason = 'evidence_changed';
    if (reason === null) {
      const res = await acceptInTx(tx, acceptInput(batch, item));
      if (res.ok) {
        const p = res.prior;
        await tx`update decider_batch_items
                    set status = 'accepted', match_id = ${res.matchId}, accepted_at = now(),
                        prior_state = ${p.state}, prior_identify_reason = ${p.identifyReason},
                        prior_release_id = ${p.releaseId}, prior_release_group_id = ${p.releaseGroupId},
                        prior_identified_at = ${p.identifiedAt ? p.identifiedAt.toISOString() : null}::timestamptz,
                        prior_match_id = ${p.liveMatchId}, prior_match_status = ${p.liveMatchStatus},
                        prior_match_reason = ${p.liveMatchReason}
                  where id = ${item.id}`;
        return { status: 'accepted', matchId: res.matchId } as Outcome;
      }
      reason = res.reason;
    }
    await tx`update decider_batch_items set status = 'skipped', skip_reason = ${reason} where id = ${item.id}`;
    return { status: 'skipped', reason } as Outcome;
  });
}

const sum = (r: Record<string, number>): number => Object.values(r).reduce((a, b) => a + b, 0);

/**
 * Accepts what is still pending in the batch. A failed run marks its own
 * activity row failed; the batch stays accepting while a retry follows (the
 * retry resumes at the first pending item) and fails on the last attempt.
 * Every batch state change is conditional: when someone else moved the
 * batch meanwhile (an undo was asked for), the run stops after the chunk in
 * hand and leaves the batch, and the gaps recompute, alone.
 */
export async function runAcceptBatch(ctx: WorkerContext, batchId: string, attempt: BatchAttempt = {}): Promise<BatchRunResult> {
  const result: BatchRunResult = { accepted: 0, undone: 0, skipped: {}, left: {} };
  const batch = await getBatch(ctx.sql, batchId);
  if (!batch || !(await transitionBatch(ctx.sql, batchId, ['queued', 'accepting'], 'accepting'))) return result;
  const total = (await batchCounts(ctx.sql, batchId)).pending;
  const progress = { libraryId: batch.libraryId, type: 'decider.accept', subjectType: 'batch', subjectId: batchId };
  const done = () => result.accepted + sum(result.skipped);
  let runId: string | null = null;
  let failureRecorded = false;
  try {
    let movedOn = false;
    for (;;) {
      const [now] = await ctx.sql<Array<{ state: string }>>`select state from decider_batches where id = ${batchId}`;
      if (now?.state !== 'accepting') { movedOn = true; break; }
      const chunk = await itemsWithStatus(ctx.sql, batchId, 'pending', ACCEPT_CHUNK);
      if (chunk.length === 0) break;
      // An input acceptInTx would refuse is a bug in whatever built the batch:
      // the batch fails before this chunk touches anything, and says why.
      for (const item of chunk) {
        try {
          assertAcceptInput(acceptInput(batch, item));
        } catch (err) {
          if (!(err instanceof RangeError)) throw err;
          const message = `Item ${item.id} cannot be accepted: ${err.message}`;
          failureRecorded = true;
          await transitionBatch(ctx.sql, batchId, ['accepting'], 'failed', { message });
          await reportProgress(ctx, runId, { ...progress, state: 'failed', done: done(), total, error: message });
          throw err;
        }
      }
      let acceptedHere = 0;
      for (const item of chunk) {
        const o = await acceptItem(ctx, batch, item);
        if (o.status === 'accepted') acceptedHere += 1;
        else if (o.status === 'skipped') result.skipped[o.reason] = (result.skipped[o.reason] ?? 0) + 1;
      }
      result.accepted += acceptedHere;
      if (acceptedHere > 0) await notifyQueueChanged(ctx, batch.libraryId, null, 'matched');
      runId = await reportProgress(ctx, runId, { ...progress, state: 'running', done: done(), total });
    }
    if (movedOn) {
      await reportProgress(ctx, runId, { ...progress, state: 'cancelled', done: done(), total, message: 'Stopped: the batch was moved on' });
      return result;
    }
    // the whole batch's counts, so a run that resumed another still says what the batch did
    const counts = await batchCounts(ctx.sql, batchId);
    // before the state change: a crash between the two still leaves the
    // recompute queued (it is keyed per library, so a repeat is harmless)
    if (counts.accepted > 0) {
      await ctx.boss.send('gaps.recompute', { libraryId: batch.libraryId }, { singletonKey: `gaps:${batch.libraryId}` });
    }
    const message = `${counts.accepted} accepted, ${counts.skipped} skipped`;
    const finished = await transitionBatch(ctx.sql, batchId, ['accepting'], 'accepted', { message });
    await reportProgress(ctx, runId, finished
      ? { ...progress, state: 'completed', done: done(), total, message }
      : { ...progress, state: 'cancelled', done: done(), total, message: 'Stopped: the batch was moved on' });
    return result;
  } catch (err) {
    if (!failureRecorded) {
      const message = err instanceof Error ? err.message : String(err);
      // best effort: the error that stopped the run is the one to rethrow
      try {
        await reportProgress(ctx, runId, { ...progress, state: 'failed', done: done(), total, error: message });
        if (attempt.lastAttempt ?? true) {
          await transitionBatch(ctx.sql, batchId, ['accepting'], 'failed', { message: `Accept stopped: ${message}` });
        }
      } catch (recordErr) {
        ctx.logger.error({ batchId, err: (recordErr as Error).message }, 'decider.accept could not record its failure');
      }
    }
    throw err;
  }
}

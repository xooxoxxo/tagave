import { getBatch } from '@tagave/db';
import type { WorkerContext } from '../lib/context.js';
import { reportProgress } from './progress.js';
import { acceptByRules, RulesBatchFailed } from '../lib/autoAccept.js';

export interface QueueAutoAcceptJobData {
  libraryId: string;
  /** 'rules' ("Accept N now"). A job queued by an older version without it
   * runs the rules too: the chip-rule sweep it used to mean is retired. */
  mode?: 'rules';
  /** who pressed "Accept N now" or "Run again"; the batch records it */
  requestedByUserId?: string;
}

/**
 * "Accept N now" and "Run again": the saved rules over the whole queue, as
 * one batch the owner can undo, and one Activity entry.
 */
export async function queueAutoAcceptJob(ctx: WorkerContext, data: QueueAutoAcceptJobData): Promise<void> {
  let run: Awaited<ReturnType<typeof acceptByRules>>;
  try {
    run = await acceptByRules(ctx, data.libraryId, {
      requireEnabled: false, viaBatch: true, startedByUserId: data.requestedByUserId ?? null,
    });
  } catch (err) {
    if (!(err instanceof RulesBatchFailed)) throw err;
    // The batch is made and marked failed with its reason. A retry of this
    // job would run the rules again into a second batch, so it ends here:
    // the owner can undo what the batch took, or run the rules again.
    ctx.logger.error({ libraryId: data.libraryId, batchId: err.batchId, err: err.message }, 'auto-accept rules: batch stopped');
    await recordRun(ctx, data.libraryId, err.batchId, async () => {
      const batch = await getBatch(ctx.sql, err.batchId);
      await reportProgress(ctx, null, {
        libraryId: data.libraryId, type: 'queue.autoaccept', state: 'failed', done: 0, total: 0,
        error: batch?.message ?? 'Accept stopped',
      });
    });
    return;
  }
  await recordRun(ctx, data.libraryId, run.batchId, () => reportProgress(ctx, null, {
    libraryId: data.libraryId, type: 'queue.autoaccept', state: 'completed', done: run.accepted, total: run.considered,
    message: `${run.accepted}/${run.considered} needs_review albums accepted by the auto-accept rules`,
  }));
  ctx.logger.info({ libraryId: data.libraryId, batchId: run.batchId, accepted: run.accepted, considered: run.considered }, 'auto-accept rules sweep done');
}

/**
 * The Activity entry for a run. Once a batch exists a failure here is only
 * logged: rethrown, it would have pg-boss run the rules again into a second
 * batch.
 */
async function recordRun(ctx: WorkerContext, libraryId: string, batchId: string | null, write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
  } catch (err) {
    if (!batchId) throw err;
    ctx.logger.error({ libraryId, batchId, err: (err as Error).message }, 'auto-accept rules: could not record the run');
  }
}

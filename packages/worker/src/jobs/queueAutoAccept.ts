import type { WorkerContext } from '../lib/context.js';
import { reportProgress } from './progress.js';
import { acceptByRules } from '../lib/autoAccept.js';

export interface QueueAutoAcceptJobData {
  libraryId: string;
  /** 'rules' ("Accept N now"). A job queued by an older version without it
   * runs the rules too: the chip-rule sweep it used to mean is retired. */
  mode?: 'rules';
}

/** "Accept N now" and "Run again": the saved rules over the whole queue, one Activity entry. */
export async function queueAutoAcceptJob(ctx: WorkerContext, data: QueueAutoAcceptJobData): Promise<void> {
  const run = await acceptByRules(ctx, data.libraryId, { requireEnabled: false });
  await reportProgress(ctx, null, {
    libraryId: data.libraryId, type: 'queue.autoaccept', state: 'completed', done: run.accepted, total: run.considered,
    message: `${run.accepted}/${run.considered} needs_review albums accepted by the auto-accept rules`,
  });
  ctx.logger.info({ libraryId: data.libraryId, accepted: run.accepted, considered: run.considered }, 'auto-accept rules sweep done');
}

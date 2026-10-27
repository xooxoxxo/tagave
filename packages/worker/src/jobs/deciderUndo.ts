/** decider.accept in undo mode: not available yet. */
import type { WorkerContext } from '../lib/context.js';
import type { BatchRunResult } from './deciderAccept.js';

export async function runUndoBatch(_ctx: WorkerContext, _batchId: string): Promise<BatchRunResult> {
  throw new Error('undo is not available yet');
}

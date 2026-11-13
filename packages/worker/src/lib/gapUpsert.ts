import { keepGapDecision } from '@tagave/db';
import type { Sql } from './context.js';

/**
 * The shared ON CONFLICT tail of every gap upsert (natural key 0032:
 * library, kind, subject_type, subject_id, flag).
 *
 * A gap that still holds keeps the owner's decision: a hidden gap stays
 * hidden and a task ('todo', "Add to my tasks") stays on the task list until
 * the condition is gone — the recompute's sweep then marks it resolved and
 * accepted_at keeps it under Done. A resolved gap whose condition came back
 * opens again as a fresh gap (no longer a task). Defined in @tagave/db
 * (keepGapDecision), which the api's album-level recompute shares.
 */
export function keepDecisionOnConflict(sql: Sql) {
  return keepGapDecision(sql);
}

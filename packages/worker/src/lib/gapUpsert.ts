import type { Sql } from './context.js';

/**
 * The shared ON CONFLICT tail of every gap upsert (natural key 0032:
 * library, kind, subject_type, subject_id, flag).
 *
 * A gap that still holds keeps the owner's decision: a hidden gap stays
 * hidden and a task ('todo', "Add to my tasks") stays on the task list until
 * the condition is gone — the recompute's sweep then marks it resolved and
 * accepted_at keeps it under Done. A resolved gap whose condition came back
 * opens again as a fresh gap (no longer a task).
 */
export function keepDecisionOnConflict(sql: Sql) {
  return sql`
    on conflict (library_id, kind, subject_type, subject_id, flag)
    do update set details = excluded.details,
                  state = case when gaps.state in ('dismissed', 'todo') then gaps.state else 'open' end,
                  accepted_at = case when gaps.state = 'resolved' then null else gaps.accepted_at end,
                  resolved_at = null`;
}

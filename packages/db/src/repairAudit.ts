/**
 * Repair (Settings › Updates › Repair) in the audit log: no table of its own.
 *
 *   updater.repair.start   the owner pressed Repair (actor_user_id: the owner)
 *   updater.repair         the updater reported how a repair settled:
 *                          { status, cause }, fixed codes only
 *
 * The same rule as music.heal (musicFolder.ts): never text from the host,
 * so no address, path or error message reaches a payload.
 */
import type postgres from 'postgres';

type Q = postgres.Sql<any> | postgres.TransactionSql<any>;

export const REPAIR_START = 'updater.repair.start';
export const REPAIR_END = 'updater.repair';

/**
 * How a repair settled: RepairStatus in packages/shared/src/updater.ts
 * without 'running' (a repair under way is no end). This package does not
 * depend on shared: change both together (updater.db.test.ts checks them).
 */
export const REPAIR_STATUSES = ['repaired', 'waiting', 'needs_you', 'failed'] as const;
export type RepairEndStatus = (typeof REPAIR_STATUSES)[number];

/** What the check step found: RepairCause in packages/shared/src/updater.ts, the same list. */
export const REPAIR_CAUSES = [
  'music_unreachable',
  'music_unmounted',
  'not_in_fstab',
  'stuck_stop',
  'crash_loop',
  'disk_full',
  'oom',
  'port_conflict',
  'app_unhealthy',
  'db_recovering',
  'docker_unresponsive',
  'migration_refused',
  'missing',
] as const;
export type RepairCauseCode = (typeof REPAIR_CAUSES)[number];

export interface RepairEnd {
  status: RepairEndStatus;
  cause: RepairCauseCode | null;
}

/** `{ status, cause }` when both are known codes (cause may be null), else null. */
export function parseRepairEnd(body: unknown): RepairEnd | null {
  const b = body as { status?: unknown; cause?: unknown } | null;
  if (!b || !(REPAIR_STATUSES as readonly unknown[]).includes(b.status)) return null;
  if (b.cause !== null && !(REPAIR_CAUSES as readonly unknown[]).includes(b.cause)) return null;
  return { status: b.status as RepairEndStatus, cause: b.cause as RepairCauseCode | null };
}

/** The owner started a repair; the library is none (the install's). */
export async function recordRepairStart(sql: Q, userId: string): Promise<void> {
  await sql`insert into audit_log (library_id, actor_user_id, action, subject_type, payload)
            values (null, ${userId}, ${REPAIR_START}, 'updater', '{}'::jsonb)`;
}

/** The updater reported how a repair settled. */
export async function recordRepairEnd(sql: Q, end: RepairEnd): Promise<void> {
  const payload = { status: end.status, cause: end.cause };
  await sql`insert into audit_log (library_id, actor_user_id, action, subject_type, payload)
            values (null, null, ${REPAIR_END}, 'updater', ${JSON.stringify(payload)}::text::jsonb)`;
}

/**
 * Which dump a roll back restores. One database dump per update: the new
 * app writes tagave-<time>-pre-migration.pgdump right before it migrates and
 * records it in its database (_migration_backups, db/src/migrations-lib.ts),
 * after the workers have stopped. A roll back needs a restore only when the
 * migration count moved, and then that dump exists and is the newest
 * rollback point, so the updater takes no dump of its own.
 *
 * The updater still takes one (`tagave-doctor backup --kind before-update`,
 * filed with the app's own) when the app's cannot be counted on:
 *
 *   - TAGAVE_SKIP_PREMIGRATE_BACKUP is set: the app migrates without a dump.
 *   - The newest record is an earlier attempt at this same target: the app
 *     would take it for a retry of that attempt and reuse its dump, which is
 *     older than the data written since (the old version ran in between).
 *   - The record cannot be read: nothing says what the app will do.
 *
 *   - The migration count or the record cannot be read right before the
 *     new app starts.
 *
 * Then it starts the new app with TAGAVE_SKIP_PREMIGRATE_BACKUP=1 for that
 * boot, so either way an update writes one dump, which is what doctor's
 * pendingDelete counts per update (one phantom per run).
 */
import { envGet } from './envFile.js';

/** psql -tA prints one row per line, columns joined by `|`. */
export const BACKUPS_TABLE_SQL = "select to_regclass('public._migration_backups') is not null";
export const LAST_BACKUP_SQL =
  "select coalesce((select max(id) from _migration_backups), 0) || '|' || coalesce((select status || '|' || coalesce(to_version, '') from _migration_backups order by id desc limit 1), '|')";

/** The first record written after `afterId`: this run's first pre-migration dump, the rollback point. */
export function firstBackupSinceSql(afterId: number): string {
  const id = Math.max(0, Math.floor(afterId));
  return `select id || '|' || status || '|' || coalesce(path, '') from _migration_backups where id > ${id} order by id limit 1`;
}

export interface LastBackup {
  /** The highest id: rows above it were written during this run. */
  maxId: number;
  status: string | null;
  toVersion: string | null;
}

/** null when the output is not what LAST_BACKUP_SQL prints. */
export function parseLastBackup(out: string): LastBackup | null {
  const line = out.trim().split('\n').at(-1)?.trim() ?? '';
  const [id, status, toVersion] = line.split('|');
  const maxId = Number(id);
  if (!Number.isInteger(maxId) || maxId < 0 || status === undefined || toVersion === undefined) return null;
  return { maxId, status: status || null, toVersion: toVersion || null };
}

export interface RecordedDump {
  id: number;
  status: string;
  path: string | null;
}

/** null for no row (empty output) or output that is not a row. */
export function parseRecordedDump(out: string): RecordedDump | null {
  const line = out.trim().split('\n').at(-1)?.trim() ?? '';
  if (!line) return null;
  const [id, status, ...rest] = line.split('|');
  const n = Number(id);
  if (!Number.isInteger(n) || !status) return null;
  const path = rest.join('|');
  return { id: n, status, path: path || null };
}

const truthy = (v: string | null | undefined) => v !== null && v !== undefined && /^(1|true|yes|on)$/i.test(v.trim());

/** .env turns the app's own dump before it migrates off (LINER_ was the name before 0.9). */
export function skipsPreMigrationBackup(env: string): boolean {
  return truthy(envGet(env, 'TAGAVE_SKIP_PREMIGRATE_BACKUP')) || truthy(envGet(env, 'LINER_SKIP_PREMIGRATE_BACKUP'));
}

/**
 * Why the updater must take its own dump, or null when the new app's is
 * enough. `last`: the newest record (null: it could not be read; undefined:
 * there is no table yet, which the new app creates and then dumps).
 */
export function ownDumpReason(env: string, last: LastBackup | null | undefined, target: string): string | null {
  if (skipsPreMigrationBackup(env)) {
    return 'TAGAVE_SKIP_PREMIGRATE_BACKUP is set, so the new app migrates without a backup';
  }
  if (last === null) return 'the record of the backups the app took before earlier updates cannot be read';
  if (last && last.toVersion === target && last.status === 'ok') {
    return `an earlier attempt at ${target} left a backup the new app would reuse, and it is older than the data written since`;
  }
  return null;
}

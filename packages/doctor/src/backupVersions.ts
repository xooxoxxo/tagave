/**
 * Which tagave version each backup was taken from, for Settings › Backups.
 *
 * Dumps written from 0.12 record it in their sidecar (appVersion, and
 * toVersion before an update); listBackups reads that. For older dumps it is
 * worked out from the update history the app keeps in _migration_backups
 * (one row per update that had database changes: when, from which version,
 * to which, and the dump it took):
 * 1. a before-update dump named in a row: that row's versions, exact;
 * 2. a before-update dump the updater took (no row names it): the row the
 *    app wrote within a few hours after it, inferred;
 * 3. anything else: the version the history says was running at that time,
 *    inferred, since releases without database changes leave no row;
 * 4. nothing to go on: unknown.
 */
import { basename } from 'node:path';
import type { BackupEntry } from './backup.js';

export interface UpdateHistoryRow {
  createdAt: Date | string;
  path: string | null;
  fromVersion: string | null;
  toVersion: string | null;
}

/** How long after the updater's own dump the app's pre-migration row may follow. */
const UPDATER_ROW_WINDOW_MS = 6 * 3600 * 1000;

const time = (d: Date | string) => (d instanceof Date ? d : new Date(d)).getTime();

/** Fill `version` / `toVersion` on entries that have no recorded version. Entries with one are returned as they are. */
export function inferBackupVersions(entries: BackupEntry[], history: UpdateHistoryRow[]): BackupEntry[] {
  const rows = [...history].sort((a, b) => time(a.createdAt) - time(b.createdAt));
  const byFile = new Map(rows.filter((r) => r.path).map((r) => [basename(r.path!), r]));
  return entries.map((e) => {
    if (e.version) {
      if (e.kind === 'pre-migration' && !e.toVersion) {
        const row = byFile.get(e.name);
        if (row?.toVersion) return { ...e, toVersion: row.toVersion };
      }
      return e;
    }
    const at = time(e.createdAt);
    if (e.kind === 'pre-migration') {
      const named = byFile.get(e.name);
      if (named?.fromVersion) return { ...e, version: named.fromVersion, versionInferred: false, toVersion: named.toVersion };
      const next = rows.find((r) => time(r.createdAt) >= at && time(r.createdAt) - at <= UPDATER_ROW_WINDOW_MS);
      if (next?.fromVersion) return { ...e, version: next.fromVersion, versionInferred: true, toVersion: next.toVersion };
    }
    let version: string | null = null;
    for (const r of rows) {
      if (time(r.createdAt) <= at) version = r.toVersion ?? version;
      else break;
    }
    if (version === null) version = rows.find((r) => time(r.createdAt) > at)?.fromVersion ?? null;
    return { ...e, version, versionInferred: version !== null, toVersion: e.toVersion };
  });
}

type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<readonly Record<string, unknown>[]>;

/** The update history from _migration_backups, oldest first; empty when the table does not exist yet. */
export async function readUpdateHistory(sql: Sql): Promise<UpdateHistoryRow[]> {
  const t = await sql`select to_regclass('public._migration_backups') as t`;
  if (!t[0]?.['t']) return [];
  const rows = await sql`select created_at, path, from_version, to_version from _migration_backups order by created_at, id`;
  return rows.map((r) => ({
    createdAt: r['created_at'] as Date,
    path: (r['path'] as string | null) ?? null,
    fromVersion: (r['from_version'] as string | null) ?? null,
    toVersion: (r['to_version'] as string | null) ?? null,
  }));
}

/**
 * Settings › Storage: how much room each kind of data takes, in the database
 * and in the folders the app owns, and the tag-change cleanup.
 */
import { lstat, readdir } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { sql } from 'drizzle-orm';
import {
  FINISHED_PLAN_STATUSES,
  STORAGE_CATEGORIES,
  storageCategoryOf,
  type StorageCategoryView,
  type TagChangeCleanupPreview,
  type TagChangeCleanupResult,
  type TagChangeCleanupScope,
} from '@tagave/shared';
import type { getDb } from '../db.js';

type Db = ReturnType<typeof getDb>;
type Row = Record<string, unknown>;
const rowsOf = async (db: Db, query: ReturnType<typeof sql>) => (await db.execute(query)) as unknown as Row[];
/** bigint and numeric come back from postgres.js as strings. */
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

/** Tables per group, largest first. Partitions count on their own (a partitioned parent is 0). */
export async function databaseUsage(db: Db): Promise<{ totalBytes: number; categories: StorageCategoryView[] }> {
  const tables = await rowsOf(db, sql`
    select n.nspname as schema, c.relname as name, pg_total_relation_size(c.oid)::bigint as bytes
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'm')
       and n.nspname not in ('pg_catalog', 'information_schema')
       and n.nspname not like 'pg_toast%'
       and n.nspname not like 'pg_temp%'`);
  const [total] = await rowsOf(db, sql`select pg_database_size(current_database())::bigint as bytes`);
  const totalBytes = num(total?.['bytes']);
  const groups = new Map<string, StorageCategoryView>(
    STORAGE_CATEGORIES.map((c) => [c.key, { key: c.key, label: c.label, description: c.description, bytes: 0, tables: [] }]),
  );
  let tableBytes = 0;
  for (const t of tables) {
    const schema = String(t['schema']);
    const name = String(t['name']);
    const bytes = num(t['bytes']);
    const group = groups.get(storageCategoryOf(schema, name))!;
    group.bytes += bytes;
    group.tables.push({ name: schema === 'public' ? name : `${schema}.${name}`, bytes });
    tableBytes += bytes;
  }
  // System catalogs and free pages: what the database holds beyond the app's tables.
  const other = groups.get('other')!;
  other.bytes += Math.max(0, totalBytes - tableBytes);
  const categories = [...groups.values()].map((g) => ({
    ...g,
    tables: g.tables.sort((a, b) => b.bytes - a.bytes).slice(0, 6),
  }));
  return { totalBytes, categories };
}

export interface FolderUsage {
  bytes: number;
  files: number;
  exists: boolean;
  truncated: boolean;
  error: string | null;
}

/** Files under a folder, without following links; stops after maxEntries. `skip` leaves a subfolder out (backups inside the cache). */
export async function folderUsage(dir: string, opts: { skip?: string; maxEntries?: number } = {}): Promise<FolderUsage> {
  const maxEntries = opts.maxEntries ?? 200_000;
  const skip = opts.skip ? resolve(opts.skip) : null;
  const out: FolderUsage = { bytes: 0, files: 0, exists: true, truncated: false, error: null };
  try {
    const st = await lstat(dir);
    if (!st.isDirectory()) return { ...out, exists: false, error: 'Not a folder' };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ...out, exists: false, error: code === 'ENOENT' ? null : (err as Error).message };
  }
  let seen = 0;
  const stack = [resolve(dir)];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (err) {
      out.error ??= `Could not read ${current}: ${(err as Error).message}`;
      continue;
    }
    for (const e of entries) {
      if (++seen > maxEntries) { out.truncated = true; return out; }
      const p = join(current, e.name);
      if (e.isDirectory()) {
        if (skip && p === skip) continue;
        stack.push(p);
      } else if (e.isFile()) {
        try {
          out.bytes += (await lstat(p)).size;
          out.files += 1;
        } catch { /* removed while walking */ }
      }
    }
  }
  return out;
}

/** True when `child` is `parent` or lies inside it. */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

const finishedList = sql.join(FINISHED_PLAN_STATUSES.map((s) => sql`${s}`), sql`, `);

/**
 * The finished plans the cleanup covers, in every library (the household
 * model: libraries are shared, owner_user_id only says who created one; the
 * route is the owner's), each with
 * whether it can still be reverted (it wrote files and has not been
 * reverted: its items hold the old tags) and about how many bytes its rows
 * take (the plan and its items: previews and the revert journal).
 */
const candidates = (scope: TagChangeCleanupScope) => sql`
  select p.id,
         (p.status <> 'reverted' and exists (
            select 1 from tag_plan_items i where i.tag_plan_id = p.id and i.status = 'applied')) as revertible,
         (pg_column_size(p.*) + coalesce((
            select sum(pg_column_size(i.*)) from tag_plan_items i where i.tag_plan_id = p.id), 0))::bigint as bytes
    from tag_plans p
   where p.status in (${finishedList})
     ${scope === 'archived' ? sql`and p.archived_at is not null` : sql``}`;

export async function previewTagChangeCleanup(db: Db, scope: TagChangeCleanupScope): Promise<TagChangeCleanupPreview> {
  const rows = await rowsOf(db, sql`
    with cand as (${candidates(scope)})
    select revertible, count(*)::int as plans, coalesce(sum(bytes), 0)::bigint as bytes
      from cand group by revertible`);
  const safe = rows.find((r) => r['revertible'] === false);
  const kept = rows.find((r) => r['revertible'] === true);
  return {
    scope,
    plans: num(safe?.['plans']),
    bytes: num(safe?.['bytes']),
    revertible: { plans: num(kept?.['plans']), bytes: num(kept?.['bytes']) },
  };
}

/** Deletes in one statement, re-checking every condition, so a plan that changed since the preview is judged as it is now. */
export async function runTagChangeCleanup(
  db: Db, scope: TagChangeCleanupScope, includeRevertible: boolean,
): Promise<TagChangeCleanupResult> {
  const [row] = await rowsOf(db, sql`
    with cand as (${candidates(scope)}),
    gone as (
      delete from tag_plans p using cand c
       where p.id = c.id ${includeRevertible ? sql`` : sql`and not c.revertible`}
      returning c.bytes)
    select count(*)::int as plans, coalesce(sum(bytes), 0)::bigint as bytes from gone`);
  return { deletedPlans: num(row?.['plans']), freedBytes: num(row?.['bytes']) };
}

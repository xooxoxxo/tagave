/**
 * Cluster holds (move-safe scanning §1, R1). A new row whose size equals a
 * missing row's may be that file moved with a new mtime (a copy, a restore):
 * only Tier 2, after parsing, can tell. Until then cluster.dir leaves its
 * folder alone, or it would build a new pending album first. A hold ends when
 * every held row of the folder is parsed or failed to parse, and in any case
 * after an hour (Ruling 7: scan.sweep releases it, every 10 minutes).
 *
 * Nothing here takes the library's reconcile lock: a release runs inside
 * scan.parse and scan.sweep, which must not wait behind a full scan.
 */
import type { WorkerContext } from './context.js';
import { clusterSingletonKey, relDirname } from './helpers.js';
import { sqlDirname, type DirRef } from './reconcile.js';

export const CLUSTER_HOLD_CAP_MS = 3_600_000;
const CAP_SECONDS = CLUSTER_HOLD_CAP_MS / 1000;
const UPDATE_BATCH = 2000;

/** Holds the fresh rows that have a size-equal missing row last seen no later than they were first seen. */
export async function placeHolds(ctx: Pick<WorkerContext, 'sql'>, freshIds: string[]): Promise<string[]> {
  const held: string[] = [];
  for (let i = 0; i < freshIds.length; i += UPDATE_BATCH) {
    const rows = await ctx.sql`
      update audio_files f set reconcile_hold_at = now()
       where f.id = any(${freshIds.slice(i, i + UPDATE_BATCH)}::uuid[]) and f.status in ('present', 'error')
         and exists (select 1 from audio_files o
                      where o.library_id = f.library_id and o.status = 'missing' and o.id <> f.id
                        and o.size_bytes = f.size_bytes and o.last_seen_at <= f.first_seen_at)
      returning f.id`;
    for (const r of rows) held.push(r['id'] as string);
  }
  return held;
}

/** 'held' while any of these rows has a hold younger than the cap; 'expired' when only older holds remain. */
export async function scopeHoldState(ctx: Pick<WorkerContext, 'sql'>, fileIds: string[]): Promise<'none' | 'held' | 'expired'> {
  if (fileIds.length === 0) return 'none';
  const [r] = await ctx.sql`
    select count(*) filter (where reconcile_hold_at > now() - ${CAP_SECONDS}::int * interval '1 second')::int as live,
           count(*) filter (where reconcile_hold_at is not null)::int as any
      from audio_files where id = any(${fileIds}::uuid[])`;
  if ((r!['live'] as number) > 0) return 'held';
  return (r!['any'] as number) > 0 ? 'expired' : 'none';
}

/** Every held row of a root; `parsed` means its tags were read or parsing failed. */
export async function heldRows(ctx: Pick<WorkerContext, 'sql'>, scanRootId: string): Promise<Array<{ id: string; dir: string; parsed: boolean; heldAt: Date }>> {
  const rows = await ctx.sql`
    select id, rel_path, (tags_read_at is not null or status = 'error') as parsed, reconcile_hold_at
      from audio_files where scan_root_id = ${scanRootId} and reconcile_hold_at is not null`;
  // The shared client reads timestamptz as text.
  return rows.map((r) => ({
    id: r['id'] as string, dir: relDirname(r['rel_path'] as string), parsed: r['parsed'] as boolean,
    heldAt: new Date(r['reconcile_hold_at'] as string | Date),
  }));
}

/** Clears the holds of these folders (Task 11 runs Tier 2 for their parsed rows first). */
export async function releaseDirHolds(ctx: WorkerContext, libraryId: string, scanRootId: string, dirs: string[]): Promise<{ released: number; reclusterDirs: DirRef[] }> {
  const wanted = new Set(dirs);
  const ids = (await heldRows(ctx, scanRootId)).filter((h) => wanted.has(h.dir)).map((h) => h.id);
  if (ids.length === 0) return { released: 0, reclusterDirs: [] };
  void libraryId; // used by Tier 2 (Task 11)
  let released = 0;
  for (let i = 0; i < ids.length; i += UPDATE_BATCH) {
    const out = await ctx.sql`
      update audio_files set reconcile_hold_at = null
       where id = any(${ids.slice(i, i + UPDATE_BATCH)}::uuid[]) and reconcile_hold_at is not null
      returning id`;
    released += out.length;
  }
  return { released, reclusterDirs: [] };
}

/** scan.parse: folders it touched whose held rows are now all parsed or failed. Returns extra dirs to cluster. */
export async function releaseReadyHolds(ctx: WorkerContext, touched: Array<{ libraryId: string; scanRootId: string; dirPath: string }>): Promise<DirRef[]> {
  const extra: DirRef[] = [];
  const byRoot = new Map<string, { libraryId: string; dirs: Set<string> }>();
  for (const t of touched) {
    const e = byRoot.get(t.scanRootId) ?? { libraryId: t.libraryId, dirs: new Set<string>() };
    e.dirs.add(t.dirPath);
    byRoot.set(t.scanRootId, e);
  }
  for (const [scanRootId, { libraryId, dirs }] of byRoot) {
    const pending = new Map<string, boolean>(); // dir -> every held row parsed
    for (const h of await heldRows(ctx, scanRootId)) {
      if (!dirs.has(h.dir)) continue;
      pending.set(h.dir, (pending.get(h.dir) ?? true) && h.parsed);
    }
    const ready = [...pending].filter(([, allParsed]) => allParsed).map(([d]) => d);
    if (ready.length === 0) continue;
    for (const d of (await releaseDirHolds(ctx, libraryId, scanRootId, ready)).reclusterDirs) extra.push(d);
  }
  return extra;
}

/** scan.sweep: holds past the cap are released and their folders clustered. */
export async function releaseExpiredHolds(ctx: WorkerContext): Promise<number> {
  const rows = await ctx.sql`
    select distinct af.library_id, af.scan_root_id, ${ctx.sql.unsafe(sqlDirname('af'))} as dir
      from audio_files af
     where af.reconcile_hold_at is not null
       and af.reconcile_hold_at <= now() - ${CAP_SECONDS}::int * interval '1 second'`;
  let released = 0;
  for (const r of rows) {
    const libraryId = r['library_id'] as string; const scanRootId = r['scan_root_id'] as string; const dirPath = r['dir'] as string;
    const res = await releaseDirHolds(ctx, libraryId, scanRootId, [dirPath]);
    released += res.released;
    for (const d of [{ scanRootId, dirPath }, ...res.reclusterDirs]) {
      await ctx.boss.send('cluster.dir', { libraryId, scanRootId: d.scanRootId, dirPath: d.dirPath },
        { singletonKey: clusterSingletonKey(d.scanRootId, d.dirPath), singletonSeconds: 30 });
    }
  }
  if (released > 0) ctx.logger.info({ released }, 'cluster holds released after the one-hour cap');
  return released;
}

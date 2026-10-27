/**
 * Cluster holds (move-safe scanning §1, R1). A new row whose size equals a
 * missing row's may be that file moved with a new mtime (a copy, a restore):
 * only Tier 2, after parsing, can tell. Until then cluster.dir leaves its
 * folder alone, or it would build a new pending album first. A hold ends when
 * every held row of the folder is parsed or failed to parse, and in any case
 * after an hour (Ruling 7: scan.sweep releases it, every 10 minutes).
 *
 * A release runs Tier 2 for the folder's parsed held rows first. It runs
 * inside scan.parse and scan.sweep, which must not wait behind a full scan, so
 * Tier 2 only tries the library's reconcile lock. When the lock is busy a
 * folder that is ready keeps its holds (nothing is clustered) and scan.sweep
 * tries again within ten minutes (releaseParsedHolds); at the cap the hold is
 * released all the same and the rows fall through to clustering unpaired.
 */
import type { WorkerContext } from './context.js';
import { clusterSingletonKey, relDirname } from './helpers.js';
import { describeMoves, emptyReconcile, reconcileTier2, sqlDirname, type DirRef } from './reconcile.js';
import { errorMessage } from './dbErrors.js';

export const CLUSTER_HOLD_CAP_MS = 3_600_000;
const CAP_SECONDS = CLUSTER_HOLD_CAP_MS / 1000;
const UPDATE_BATCH = 2000;
/** scan.parse batch size for Tier 2 merges whose bytes changed (scan.root and scan.dir use the same). */
const PARSE_BATCH = 50;

/** A folder to cluster after a release, with the library it belongs to. */
export interface ReleasedDir extends DirRef { libraryId: string }

/**
 * cluster.dir for a folder whose hold was just cleared. No singletonSeconds,
 * on purpose: a throttle slot is unique on (name, slot, key) for every state
 * but cancelled, so a cluster.dir that returned early on this hold and
 * completed in the same 30 s slot would silently swallow this send, and the
 * folder would never be clustered. The stately policy and the singletonKey
 * still drop a duplicate while one is queued, and that queued job runs after
 * the release, so it clusters the folder.
 */
export async function sendReleasedCluster(ctx: Pick<WorkerContext, 'boss'>, d: ReleasedDir, startAfter?: number): Promise<void> {
  await ctx.boss.send('cluster.dir', { libraryId: d.libraryId, scanRootId: d.scanRootId, dirPath: d.dirPath },
    { singletonKey: clusterSingletonKey(d.scanRootId, d.dirPath), ...(startAfter ? { startAfter } : {}) });
}

/**
 * Holds the fresh rows that have a size-equal missing row last seen before
 * they were first seen. Strictly before, as Tier 1 and Tier 2 pair: equal
 * times mean both paths were seen in one walk batch, so the two files
 * coexisted and the new one cannot be the old one moved.
 */
export async function placeHolds(ctx: Pick<WorkerContext, 'sql'>, freshIds: string[]): Promise<string[]> {
  const held: string[] = [];
  for (let i = 0; i < freshIds.length; i += UPDATE_BATCH) {
    const rows = await ctx.sql`
      update audio_files f set reconcile_hold_at = now()
       where f.id = any(${freshIds.slice(i, i + UPDATE_BATCH)}::uuid[]) and f.status in ('present', 'error')
         and exists (select 1 from audio_files o
                      where o.library_id = f.library_id and o.status = 'missing' and o.id <> f.id
                        and o.size_bytes = f.size_bytes and o.last_seen_at < f.first_seen_at)
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

/**
 * The held rows of a root, only those directly in `dirs` when given (a parse
 * job touches a few folders; a root can hold thousands of rows elsewhere).
 * `parsed` means its tags were read or parsing failed.
 */
export async function heldRows(
  ctx: Pick<WorkerContext, 'sql'>, scanRootId: string, dirs?: string[],
): Promise<Array<{ id: string; dir: string; parsed: boolean; heldAt: Date }>> {
  const rows = await ctx.sql`
    select af.id, af.rel_path, (af.tags_read_at is not null or af.status = 'error') as parsed, af.reconcile_hold_at
      from audio_files af where af.scan_root_id = ${scanRootId} and af.reconcile_hold_at is not null
       ${dirs ? ctx.sql`and ${ctx.sql.unsafe(sqlDirname('af'))} = any(${dirs}::text[])` : ctx.sql``}`;
  // The shared client reads timestamptz as text.
  return rows.map((r) => ({
    id: r['id'] as string, dir: relDirname(r['rel_path'] as string), parsed: r['parsed'] as boolean,
    heldAt: new Date(r['reconcile_hold_at'] as string | Date),
  }));
}

export interface DirRelease {
  released: number;
  /** Folders Tier 2 took files from, other than the released ones (those the caller clusters anyway). */
  reclusterDirs: DirRef[];
  /** The library lock was busy, so Tier 2 did not run and the holds were kept (never at the cap). */
  deferred: boolean;
}

/**
 * Runs Tier 2 for the parsed held rows of these folders, then clears their
 * holds. Rows still unparsed lose Tier 2 (Ruling 7). On a busy library lock
 * the holds stay and nothing changes (`deferred`), unless `atCap`: a hold
 * never outlives the hour, so then the holds go and the rows stay unpaired.
 */
export async function releaseDirHolds(
  ctx: WorkerContext, libraryId: string, scanRootId: string, dirs: string[], opts: { atCap?: boolean } = {},
): Promise<DirRelease> {
  const wanted = new Set(dirs);
  const held = (await heldRows(ctx, scanRootId, dirs)).filter((h) => wanted.has(h.dir));
  if (held.length === 0) return { released: 0, reclusterDirs: [], deferred: false };
  const parsedIds = held.filter((h) => h.parsed).map((h) => h.id);
  let rec: Awaited<ReturnType<typeof reconcileTier2>>;
  try {
    rec = await reconcileTier2(ctx, libraryId, parsedIds);
  } catch (err) {
    // At the cap a hold never outlives the hour: a failed Tier 2 releases unpaired.
    if (!opts.atCap) throw err;
    ctx.logger.warn({ scanRootId, dirs: dirs.length, err: errorMessage(err) }, 'files.reconcile: Tier 2 failed at the hold cap, released without it');
    rec = { ...emptyReconcile(), lockBusy: false };
  }
  if (rec.lockBusy) {
    if (!opts.atCap) {
      ctx.logger.debug({ scanRootId, dirs: dirs.length }, 'files.reconcile: library busy, Tier 2 and the hold release wait for the next sweep');
      return { released: 0, reclusterDirs: [], deferred: true };
    }
    ctx.logger.warn({ scanRootId, dirs: dirs.length }, 'files.reconcile: library busy at the hold cap, released without Tier 2');
  }
  // A merged old row's hold was cleared by mergeFilePair; the fresh row it came from is gone.
  const ids = held.map((h) => h.id);
  let released = 0;
  for (let i = 0; i < ids.length; i += UPDATE_BATCH) {
    const out = await ctx.sql`
      update audio_files set reconcile_hold_at = null
       where id = any(${ids.slice(i, i + UPDATE_BATCH)}::uuid[]) and reconcile_hold_at is not null
      returning id`;
    released += out.length;
  }
  // A merge that took an unparsed row with other bytes needs the old row parsed again.
  for (let i = 0; i < rec.reparseIds.length; i += PARSE_BATCH) {
    await ctx.boss.send('scan.parse', { audioFileIds: rec.reparseIds.slice(i, i + PARSE_BATCH) });
  }
  if (rec.merged > 0) ctx.logger.info({ scanRootId, merged: rec.merged, moves: describeMoves(rec.moves) }, 'files.reconcile: Tier 2');
  // Old folders lost files; the released ones are clustered by the caller already.
  const reclusterDirs = rec.reclusterDirs.filter((d) => !(d.scanRootId === scanRootId && wanted.has(d.dirPath)));
  const heldIds = new Set(ids);
  for (const id of rec.mergedFreshIds) if (heldIds.has(id)) released += 1;
  return { released, reclusterDirs, deferred: false };
}

/**
 * scan.parse: releases the touched folders whose held rows are now all parsed
 * or failed. Returns every folder to cluster because of a release: the
 * released folders themselves plus the folders Tier 2 took files from. A
 * folder deferred on a busy library lock is not returned (it stays held).
 * The caller sends these with sendReleasedCluster, not its throttled send.
 */
export async function releaseReadyHolds(ctx: WorkerContext, touched: Array<{ libraryId: string; scanRootId: string; dirPath: string }>): Promise<ReleasedDir[]> {
  const out: ReleasedDir[] = [];
  const byRoot = new Map<string, { libraryId: string; dirs: Set<string> }>();
  for (const t of touched) {
    const e = byRoot.get(t.scanRootId) ?? { libraryId: t.libraryId, dirs: new Set<string>() };
    e.dirs.add(t.dirPath);
    byRoot.set(t.scanRootId, e);
  }
  for (const [scanRootId, { libraryId, dirs }] of byRoot) {
    const pending = new Map<string, boolean>(); // dir -> every held row parsed
    for (const h of await heldRows(ctx, scanRootId, [...dirs])) {
      if (!dirs.has(h.dir)) continue;
      pending.set(h.dir, (pending.get(h.dir) ?? true) && h.parsed);
    }
    const ready = [...pending].filter(([, allParsed]) => allParsed).map(([d]) => d);
    if (ready.length === 0) continue;
    const res = await releaseDirHolds(ctx, libraryId, scanRootId, ready);
    if (res.deferred) continue;
    for (const dirPath of ready) out.push({ libraryId, scanRootId, dirPath });
    for (const d of res.reclusterDirs) out.push({ libraryId, ...d });
  }
  return out;
}

/** Limits a sweep to one library (tests on the shared database); production sweeps everything. */
export interface HoldScope { libraryId: string }

/**
 * scan.sweep: holds past the cap are released and their folders clustered.
 * Tier 2 still runs for their parsed rows, but neither a busy library lock nor
 * a Tier 2 error keeps the hold, and one folder's error never stops the rest.
 * Returns the number of folders released.
 */
export async function releaseExpiredHolds(ctx: WorkerContext, scope?: HoldScope): Promise<number> {
  const rows = await ctx.sql`
    select distinct af.library_id, af.scan_root_id, ${ctx.sql.unsafe(sqlDirname('af'))} as dir
      from audio_files af
     where af.reconcile_hold_at is not null
       and af.reconcile_hold_at <= now() - ${CAP_SECONDS}::int * interval '1 second'
       ${scope ? ctx.sql`and af.library_id = ${scope.libraryId}` : ctx.sql``}`;
  let folders = 0;
  for (const r of rows) {
    const libraryId = r['library_id'] as string; const scanRootId = r['scan_root_id'] as string; const dirPath = r['dir'] as string;
    try {
      const res = await releaseDirHolds(ctx, libraryId, scanRootId, [dirPath], { atCap: true });
      if (res.released > 0) folders += 1;
      await sendReleasedCluster(ctx, { libraryId, scanRootId, dirPath });
      for (const d of res.reclusterDirs) await sendReleasedCluster(ctx, { libraryId, ...d });
    } catch (err) {
      ctx.logger.warn({ scanRootId, dirPath, err: errorMessage(err) }, 'cluster hold release at the cap failed for a folder');
    }
  }
  if (folders > 0) ctx.logger.info({ folders }, 'cluster holds released after the one-hour cap');
  return folders;
}

/**
 * scan.sweep: folders whose held rows are all parsed but still held, because
 * Tier 2 found the library lock busy when scan.parse released them, get
 * another try (and their cluster.dir once released, plus the folders Tier 2
 * took files from). Still busy: they wait for the next sweep, and the cap
 * releases them in any case. Returns the number of folders released (the
 * same unit as releaseExpiredHolds; the extra Tier 2 folders do not count).
 */
export async function releaseParsedHolds(ctx: WorkerContext, scope?: HoldScope): Promise<number> {
  const rows = await ctx.sql`
    select af.library_id, af.scan_root_id, ${ctx.sql.unsafe(sqlDirname('af'))} as dir
      from audio_files af
     where af.reconcile_hold_at is not null
       and af.reconcile_hold_at > now() - ${CAP_SECONDS}::int * interval '1 second'
       ${scope ? ctx.sql`and af.library_id = ${scope.libraryId}` : ctx.sql``}
     group by 1, 2, 3
    having bool_and(af.tags_read_at is not null or af.status = 'error')`;
  if (rows.length === 0) return 0;
  const touched = rows.map((r) => ({ libraryId: r['library_id'] as string, scanRootId: r['scan_root_id'] as string, dirPath: r['dir'] as string }));
  const wanted = new Set(touched.map((t) => `${t.scanRootId}\n${t.dirPath}`));
  const out = await releaseReadyHolds(ctx, touched);
  for (const d of out) await sendReleasedCluster(ctx, d);
  return out.filter((d) => wanted.has(`${d.scanRootId}\n${d.dirPath}`)).length;
}

/**
 * What runs after a walk (move-safe scanning §1, §3), under the library's
 * reconcile lock: Tier 1 reconciliation, missing-marking with its guards,
 * cluster holds (Task 10), stale sidecars.
 * Missing-marking only touches a row that is still where the walk's snapshot
 * saw it and was last seen before the walk began, by the database's clock: a
 * row a concurrent scan.dir re-pointed is never marked missing (R7).
 */
import { escapeLike, relDirname, sqlDirname } from './helpers.js';
import type { WorkerContext } from './context.js';
import type { WalkRoot, WalkTreeResult } from './walk.js';
import { reconcileTier1, withLibraryLock, type DirRef, type MoveRecord } from './reconcile.js';
import { placeHolds } from './clusterHold.js';

export type { MoveRecord, DirRef } from './reconcile.js';

export interface FinishOptions {
  /** skip the partly-unmounted hold (release B's Missing list › Confirm missing) */
  confirmMissing?: boolean;
}
export interface FinishResult {
  missing: number; dirsWithMissing: string[];
  failedDirs: string[]; heldMissing: { count: number; threshold: number } | null; reconcileSkipped: string | null; // Task 5
  merged: number; moves: MoveRecord[]; possibleMoves: number; reclusterDirs: DirRef[];                              // Task 8
  held: number;                                                                                                       // Task 10
}
const UPDATE_BATCH = 2000;

export async function markMissing(
  ctx: Pick<WorkerContext, 'sql'>,
  root: WalkRoot,
  rows: Array<{ id: string; relPath: string }>,
  walkStart: Date,
): Promise<Array<{ id: string; relPath: string }>> {
  const marked: Array<{ id: string; relPath: string }> = [];
  for (let i = 0; i < rows.length; i += UPDATE_BATCH) {
    const chunk = rows.slice(i, i + UPDATE_BATCH);
    const out = (await ctx.sql`
      update audio_files af set status = 'missing'
        from unnest(${chunk.map((r) => r.id)}::uuid[], ${chunk.map((r) => r.relPath)}::text[]) as u(id, rel_path)
       where af.id = u.id and af.rel_path = u.rel_path and af.scan_root_id = ${root.id}
         and af.last_seen_at < ${walkStart.toISOString()}::timestamptz and af.status in ('present', 'error')
      returning af.id, af.rel_path as "relPath"`) as unknown as Array<{ id: string; relPath: string }>;
    marked.push(...out);
  }
  return marked;
}

/**
 * Sidecars in scope the walk did not see: their images first (cascade since 0052), then the rows.
 * Sidecars under a failed path were not seen because they could not be read, not because they
 * left, so they stay (F5: dropping one would cascade its cover away). The candidates are
 * filtered in JS with one set lookup per path level, then deleted by id (the last_seen guard
 * is re-checked, so a row a concurrent walk just saw stays).
 * Ruling 9 (widened in Task 13's review): a stale sidecar an image points at
 * stays while a missing audio row lies in its folder, in a folder under it
 * (Album/folder.jpg over CD1/, CD2/) or in a folder above it up to the root
 * (Album/Scans/folder.jpg). A cross-root move scanned source-first, or a Tier 2
 * move, pairs after this walk; repointSidecarImages then moves the image to the
 * new folder's sidecar, and a later scan drops the old row once nothing points
 * at it or nothing near it is missing. Runs after markMissing, so this walk's
 * missing rows count. The root's missing folders are loaded once and matched in JS.
 */
export async function dropStaleSidecars(
  ctx: Pick<WorkerContext, 'sql'>, root: WalkRoot, subtree: string, walkStart: Date,
  failedPaths: Iterable<string> = [],
): Promise<number> {
  const failed = failedPaths instanceof Set ? failedPaths as ReadonlySet<string> : new Set(failedPaths);
  if (failed.has('')) return 0;
  const prefix = subtree ? subtree + '/' : '';
  const since = walkStart.toISOString();
  const stale = (await ctx.sql`
    select s.id, s.rel_path as "relPath",
           s.id in (select i.sidecar_file_id from images i where i.sidecar_file_id is not null) as "hasImages"
      from sidecar_files s
     where s.scan_root_id = ${root.id} and s.last_seen_at < ${since}::timestamptz
       and (${prefix} = '' or s.rel_path like ${escapeLike(prefix) + '%'})`) as unknown as Array<{ id: string; relPath: string; hasImages: boolean }>;
  let candidates = failed.size ? stale.filter((r) => !isUnderFailedPath(r.relPath, failed)) : stale;
  if (candidates.some((r) => r.hasImages)) {
    const near = await nearMissing(ctx, root.id);
    candidates = candidates.filter((r) => !(r.hasImages && near(relDirname(r.relPath))));
  }
  const ids = candidates.map((r) => r.id);
  let dropped = 0;
  for (let i = 0; i < ids.length; i += UPDATE_BATCH) {
    const gone = await ctx.sql`
      delete from sidecar_files s
       where s.id = any(${ids.slice(i, i + UPDATE_BATCH)}::uuid[]) and s.last_seen_at < ${since}::timestamptz
      returning s.id`;
    dropped += gone.length;
  }
  return dropped;
}

/**
 * Whether a folder has a missing audio row in it, under it or above it (up to
 * the root's top). One query for the root's distinct missing folders (by
 * scan_root_id and status), then set lookups per path level. Per the ruling,
 * "above" includes the root's top: one missing row there ('' folder) keeps
 * every stale image-bearing sidecar in that root (rows linger, no cover lost).
 */
async function nearMissing(ctx: Pick<WorkerContext, 'sql'>, rootId: string): Promise<(dir: string) => boolean> {
  const rows = (await ctx.sql`
    select distinct ${ctx.sql.unsafe(sqlDirname('a'))} as dir from audio_files a
     where a.scan_root_id = ${rootId} and a.status = 'missing'`) as unknown as Array<{ dir: string }>;
  const missing = new Set<string>();
  const missingOrAbove = new Set<string>(); // each missing folder and every folder above it
  for (const r of rows) {
    missing.add(r.dir);
    for (let d = r.dir; !missingOrAbove.has(d); d = relDirname(d)) {
      missingOrAbove.add(d);
      if (d === '') break;
    }
  }
  return (dir) => {
    if (missingOrAbove.has(dir)) return true; // missing here or below
    for (let d = dir; d !== '';) { d = relDirname(d); if (missing.has(d)) return true; }
    return false;
  };
}

/** Ruling 5: never hold a loss of this many files or fewer. */
export const HOLD_FLOOR = 10;

/**
 * More than 500 files or more than 20% of the root's present files going
 * missing in one scan, whichever is lower, looks like a share that is partly
 * unmounted (a mergerfs branch dropping out raises no read errors).
 */
export function missingHold(count: number, presentInRoot: number): { held: boolean; threshold: number } {
  const threshold = Math.max(HOLD_FLOOR, Math.min(500, Math.floor(presentInRoot * 0.2)));
  return { held: count > threshold, threshold };
}

/**
 * True when relPath is a failed path or lies under one. A folder that lists but cannot be
 * searched puts every file in it on failedPaths, so this does one set lookup per path level
 * (pass a Set to skip rebuilding it per call), never one comparison per failed path.
 */
export function isUnderFailedPath(relPath: string, failedPaths: Iterable<string>): boolean {
  const failed = failedPaths instanceof Set ? failedPaths as ReadonlySet<string> : new Set(failedPaths);
  if (failed.size === 0) return false;
  if (failed.has('') || failed.has(relPath)) return true;
  for (let i = relPath.indexOf('/'); i !== -1; i = relPath.indexOf('/', i + 1)) {
    if (failed.has(relPath.slice(0, i))) return true;
  }
  return false;
}

/** The Activity suffix for what a scan did not do and why ('' when it did everything). */
export function finishNotes(f: Pick<FinishResult, 'failedDirs' | 'heldMissing' | 'reconcileSkipped'>): string {
  const notes: string[] = [];
  if (f.failedDirs.length > 0) {
    const shown = f.failedDirs.slice(0, 3).join(', ') + (f.failedDirs.length > 3 ? `, and ${f.failedDirs.length - 3} more` : '');
    notes.push(`could not read ${shown}; nothing under them was marked missing`);
  }
  if (f.heldMissing) notes.push(`looks partly unmounted: ${f.heldMissing.count} files would go missing (more than ${f.heldMissing.threshold}), so none were marked`);
  if (f.reconcileSkipped) notes.push(f.reconcileSkipped);
  return notes.length ? '; ' + notes.join('; ') : '';
}

async function forgetDirMtimes(ctx: Pick<WorkerContext, 'sql'>, root: WalkRoot, dirs: string[]): Promise<void> {
  for (let i = 0; i < dirs.length; i += UPDATE_BATCH) {
    await ctx.sql`delete from scan_dirs where scan_root_id = ${root.id} and rel_path = any(${dirs.slice(i, i + UPDATE_BATCH)}::text[])`;
  }
}

/** The only reason Tier 1 is skipped: a root that looks unmounted marks and matches nothing. */
export const UNMOUNTED_SKIP = 'the root looks unmounted, so moved files are not matched in this scan';

export async function finishWalk(ctx: WorkerContext, root: WalkRoot, walk: WalkTreeResult, opts: FinishOptions = {}): Promise<FinishResult> {
  const empty: FinishResult = {
    missing: 0, dirsWithMissing: [], failedDirs: [], heldMissing: null, reconcileSkipped: null,
    merged: 0, moves: [], possibleMoves: 0, reclusterDirs: [], held: 0,
  };
  const failedDirs = walk.failedPaths;
  // F3: an unmounted-looking root marks nothing, but still names what it could not read.
  if (walk.looksUnmounted) return { ...empty, failedDirs, reconcileSkipped: UNMOUNTED_SKIP };
  return withLibraryLock(ctx, root.libraryId, async () => {
    // Doubt: an unreadable folder or file is not evidence that anything left.
    const failedSet = new Set(failedDirs);
    let gone = failedSet.size ? walk.unseen.filter((r) => !isUnderFailedPath(r.relPath, failedSet)) : walk.unseen;
    // Failed paths do not stop matching (an unreadable folder would otherwise
    // disable move detection for the whole root): rows under them are not in
    // `gone` and are no fresh candidates, so nothing there is paired or marked.
    // Only an unmounted-looking root (returned above) skips reconcile; the
    // Activity note for failed paths comes from failedDirs; reconcileSkipped is null here.
    const rec = await reconcileTier1(ctx, root, walk);
    const mergedOld = new Set(rec.outcomes.map((o) => o.oldId));
    gone = gone.filter((r) => !mergedOld.has(r.id));
    // scan.parse gets what is left of the fresh rows plus merged rows whose size or mtime changed
    const mergedFresh = new Set(rec.mergedFreshIds);
    walk.changedIds = [...walk.changedIds.filter((id) => !mergedFresh.has(id)), ...rec.reparseIds];
    walk.insertedIds = walk.insertedIds.filter((id) => !mergedFresh.has(id));
    const reconciled = { merged: rec.merged, moves: rec.moves, possibleMoves: rec.possibleMoves, reclusterDirs: rec.reclusterDirs };
    const hold = missingHold(gone.length, walk.presentInRoot);
    if (hold.held && !opts.confirmMissing) {
      // F5: a held scan drops no sidecars either (the 0052 cascade would take their covers).
      // A quick scan must not forget the hold: the walk just stamped fresh mtimes on the
      // folders that lost files, so the next quick scan would skip them and count the held
      // rows as seen. Drop those scan_dirs rows; the next scan walks those folders in full.
      await forgetDirMtimes(ctx, root, [...new Set(gone.map((r) => relDirname(r.relPath)))]);
      return { ...empty, ...reconciled, failedDirs, heldMissing: { count: gone.length, threshold: hold.threshold } };
    }
    const marked = await markMissing(ctx, root, gone, walk.walkStart);
    // Only a scan that reconciled may hold: Tier 2 is reconciliation too. The
    // unmounted-looking root (the one reconcile skip) returned above, so every
    // scan that gets here reconciled. Holds go on before the caller sends
    // scan.parse and cluster.dir for these rows.
    const heldIds = await placeHolds(ctx, walk.insertedIds);
    // A failed cover re-point leaves the images on the old sidecars: dropping those
    // now would take the covers with them (the 0052 cascade).
    if (rec.sidecarRepointFailed) ctx.logger.warn({ rootId: root.id }, 'scan.finish: stale sidecars kept, the cover re-point failed');
    else await dropStaleSidecars(ctx, root, walk.subtree, walk.walkStart, failedSet);
    return {
      ...empty, ...reconciled, failedDirs,
      held: heldIds.length,
      missing: marked.length,
      dirsWithMissing: [...new Set(marked.map((m) => relDirname(m.relPath)))],
    };
  });
}

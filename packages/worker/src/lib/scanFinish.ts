/**
 * What runs after a walk (move-safe scanning §1, §3), under the library's
 * reconcile lock: Tier 1 reconciliation, missing-marking with its guards,
 * cluster holds (Task 10), stale sidecars.
 * Missing-marking only touches a row that is still where the walk's snapshot
 * saw it and was last seen before the walk began, by the database's clock: a
 * row a concurrent scan.dir re-pointed is never marked missing (R7).
 */
import { escapeLike, relDirname } from './helpers.js';
import type { WorkerContext } from './context.js';
import type { WalkRoot, WalkTreeResult } from './walk.js';
import { emptyReconcile, reconcileTier1, withLibraryLock, type DirRef, type MoveRecord } from './reconcile.js';

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
    select s.id, s.rel_path as "relPath" from sidecar_files s
     where s.scan_root_id = ${root.id} and s.last_seen_at < ${since}::timestamptz
       and (${prefix} = '' or s.rel_path like ${escapeLike(prefix) + '%'})`) as unknown as Array<{ id: string; relPath: string }>;
  const ids = (failed.size ? stale.filter((r) => !isUnderFailedPath(r.relPath, failed)) : stale).map((r) => r.id);
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

export async function finishWalk(ctx: WorkerContext, root: WalkRoot, walk: WalkTreeResult, opts: FinishOptions = {}): Promise<FinishResult> {
  const empty: FinishResult = {
    missing: 0, dirsWithMissing: [], failedDirs: [], heldMissing: null, reconcileSkipped: null,
    merged: 0, moves: [], possibleMoves: 0, reclusterDirs: [], held: 0,
  };
  const failedDirs = walk.failedPaths;
  // F3: an unmounted-looking root marks nothing, but still names what it could not read.
  if (walk.looksUnmounted) return { ...empty, failedDirs };
  return withLibraryLock(ctx, root.libraryId, async () => {
    // Doubt: an unreadable folder or file is not evidence that anything left.
    const failedSet = new Set(failedDirs);
    let gone = failedSet.size ? walk.unseen.filter((r) => !isUnderFailedPath(r.relPath, failedSet)) : walk.unseen;
    // Any failed path (an unreadable folder, a file or sidecar whose stat failed,
    // say ENOENT mid-walk) means the walk's picture is incomplete: match nothing.
    const unread = Math.max(walk.errored, failedDirs.length);
    const reconcileSkipped = unread > 0
      ? `${unread} folder(s) or file(s) could not be read, so moved files are not matched in this scan`
      : null;
    const rec = reconcileSkipped === null ? await reconcileTier1(ctx, root, walk) : emptyReconcile();
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
      return { ...empty, ...reconciled, failedDirs, reconcileSkipped, heldMissing: { count: gone.length, threshold: hold.threshold } };
    }
    const marked = await markMissing(ctx, root, gone, walk.walkStart);
    await dropStaleSidecars(ctx, root, walk.subtree, walk.walkStart, failedSet);
    return {
      ...empty, ...reconciled, failedDirs, reconcileSkipped,
      missing: marked.length,
      dirsWithMissing: [...new Set(marked.map((m) => relDirname(m.relPath)))],
    };
  });
}

/**
 * What runs after a walk (move-safe scanning §1, §3): reconciliation (Task 8),
 * missing-marking with its guards, cluster holds (Task 10), stale sidecars.
 * Missing-marking only touches a row that is still where the walk's snapshot
 * saw it and was last seen before the walk began, by the database's clock: a
 * row a concurrent scan.dir re-pointed is never marked missing (R7).
 */
import { escapeLike, relDirname } from './helpers.js';
import type { WorkerContext } from './context.js';
import type { WalkRoot, WalkTreeResult } from './walk.js';

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
// Temporary home: Task 8 moves these to reconcile.ts and re-exports them.
export interface DirRef { scanRootId: string; dirPath: string }
export interface MoveRecord { fromRootId: string; fromDir: string; toRootId: string; toDir: string; files: number }

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
 * left, so they stay (F5: dropping one would cascade its cover away).
 */
export async function dropStaleSidecars(
  ctx: Pick<WorkerContext, 'sql'>, root: WalkRoot, subtree: string, walkStart: Date, failedPaths: string[] = [],
): Promise<number> {
  if (failedPaths.includes('')) return 0;
  const prefix = subtree ? subtree + '/' : '';
  const gone = await ctx.sql`
    delete from sidecar_files s
     where s.scan_root_id = ${root.id} and s.last_seen_at < ${walkStart.toISOString()}::timestamptz
       and (${prefix} = '' or s.rel_path like ${escapeLike(prefix) + '%'})
       and not exists (
         select 1 from unnest(${failedPaths}::text[]) as f(p)
          where s.rel_path = f.p or left(s.rel_path, length(f.p) + 1) = f.p || '/')
    returning s.id`;
  return gone.length;
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

export function isUnderFailedPath(relPath: string, failedPaths: string[]): boolean {
  return failedPaths.some((p) => p === '' || relPath === p || relPath.startsWith(p + '/'));
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

export async function finishWalk(ctx: WorkerContext, root: WalkRoot, walk: WalkTreeResult, opts: FinishOptions = {}): Promise<FinishResult> {
  const empty: FinishResult = {
    missing: 0, dirsWithMissing: [], failedDirs: [], heldMissing: null, reconcileSkipped: null,
    merged: 0, moves: [], possibleMoves: 0, reclusterDirs: [], held: 0,
  };
  const failedDirs = walk.failedPaths;
  // F3: an unmounted-looking root marks nothing, but still names what it could not read.
  if (walk.looksUnmounted) return { ...empty, failedDirs };
  // Doubt: an unreadable folder or file is not evidence that anything left.
  let gone = walk.unseen.filter((r) => !isUnderFailedPath(r.relPath, failedDirs));
  const reconcileSkipped = walk.errored > 0
    ? `${walk.errored} folder(s) or file(s) could not be read, so moved files are not matched in this scan`
    : null;
  // Task 8 inserts Tier 1 here (only when reconcileSkipped is null) and removes merged rows from `gone`.
  const hold = missingHold(gone.length, walk.presentInRoot);
  if (hold.held && !opts.confirmMissing) {
    // F5: a held scan drops no sidecars either (the 0052 cascade would take their covers).
    return { ...empty, failedDirs, reconcileSkipped, heldMissing: { count: gone.length, threshold: hold.threshold } };
  }
  const marked = await markMissing(ctx, root, gone, walk.walkStart);
  await dropStaleSidecars(ctx, root, walk.subtree, walk.walkStart, failedDirs);
  return {
    ...empty, failedDirs, reconcileSkipped,
    missing: marked.length,
    dirsWithMissing: [...new Set(marked.map((m) => relDirname(m.relPath)))],
  };
}

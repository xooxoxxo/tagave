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

export interface FinishOptions { confirmMissing?: boolean }
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

/** Sidecars in scope the walk did not see: their images first (cascade since 0052), then the rows. */
export async function dropStaleSidecars(ctx: Pick<WorkerContext, 'sql'>, root: WalkRoot, subtree: string, walkStart: Date): Promise<number> {
  const prefix = subtree ? subtree + '/' : '';
  const gone = await ctx.sql`
    delete from sidecar_files s
     where s.scan_root_id = ${root.id} and s.last_seen_at < ${walkStart.toISOString()}::timestamptz
       and (${prefix} = '' or s.rel_path like ${escapeLike(prefix) + '%'})
    returning s.id`;
  return gone.length;
}

export async function finishWalk(ctx: WorkerContext, root: WalkRoot, walk: WalkTreeResult, _opts: FinishOptions = {}): Promise<FinishResult> {
  const empty: FinishResult = {
    missing: 0, dirsWithMissing: [], failedDirs: [], heldMissing: null, reconcileSkipped: null,
    merged: 0, moves: [], possibleMoves: 0, reclusterDirs: [], held: 0,
  };
  if (walk.looksUnmounted) return empty;
  const marked = await markMissing(ctx, root, walk.unseen, walk.walkStart);
  await dropStaleSidecars(ctx, root, walk.subtree, walk.walkStart);
  return { ...empty, missing: marked.length, dirsWithMissing: [...new Set(marked.map((m) => relDirname(m.relPath)))] };
}

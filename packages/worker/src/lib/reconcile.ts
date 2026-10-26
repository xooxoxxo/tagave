/**
 * Reconciliation (move-safe scanning §1). Tier 1 runs at the end of each walk
 * (scan.root, scan.dir); Tier 2 after parsing (Task 11). Both run under one
 * session-level advisory lock per library, taken on a reserved connection and
 * held only for reconcile plus missing-marking, never for the walk: no
 * hours-long transaction, and a "Rescan this folder" never waits behind a
 * full walk, only behind another finish step.
 */
import type postgres from 'postgres';
import type { WorkerContext } from './context.js';
import { pgErrorCode, errorMessage } from './dbErrors.js';
import { relDirname } from './helpers.js';
import { mergeFilePair, type MergeDone, type MergeOutcome, type MergeRequest } from './fileMerge.js';
import { planPairs, type MatchFile, type Tier } from './reconcileMatch.js';
import type { WalkRoot, WalkTreeResult } from './walk.js';

export const RECONCILE_LOCK_PREFIX = 'files.reconcile:';

export interface DirRef { scanRootId: string; dirPath: string }
export interface MoveRecord { fromRootId: string; fromDir: string; toRootId: string; toDir: string; files: number }
export interface ReconcileResult {
  merged: number; moves: MoveRecord[]; possibleMoves: number;
  mergedFreshIds: string[]; reparseIds: string[]; reclusterDirs: DirRef[]; outcomes: MergeDone[];
}

export function emptyReconcile(): ReconcileResult {
  return { merged: 0, moves: [], possibleMoves: 0, mergedFreshIds: [], reparseIds: [], reclusterDirs: [], outcomes: [] };
}

export async function withLibraryLock<T>(ctx: Pick<WorkerContext, 'sql'>, libraryId: string, fn: () => Promise<T>): Promise<T> {
  const key = RECONCILE_LOCK_PREFIX + libraryId;
  const conn = await ctx.sql.reserve();
  try {
    await conn`select pg_advisory_lock(hashtextextended(${key}, 0))`;
    try {
      return await fn();
    } finally {
      await conn`select pg_advisory_unlock(hashtextextended(${key}, 0))`;
    }
  } finally {
    conn.release();
  }
}

/**
 * dirname of `<alias>.rel_path` as SQL text, '' for a file at the top of the
 * root. The one copy of this expression (pre-flight F10): it equals
 * relDirname() and reconcileMatch's dir key exactly, with no case or NFC
 * folding. Use it through `sql.unsafe(sqlDirname('af'))`.
 */
export function sqlDirname(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`sqlDirname: bad alias ${alias}`);
  return `case when strpos(${alias}.rel_path, '/') = 0 then '' else regexp_replace(${alias}.rel_path, '/[^/]*$', '') end`;
}

type Fragment = postgres.PendingQuery<postgres.Row[]>;

/** The client reads timestamptz as text, so times come back as epoch milliseconds. */
export async function loadMatchFiles(ctx: Pick<WorkerContext, 'sql'>, where: Fragment): Promise<MatchFile[]> {
  const rows = (await ctx.sql`
    select af.id, af.scan_root_id, af.rel_path, af.size_bytes::float8 as size_bytes, af.mtime::float8 as mtime, af.inode,
           af.duration_ms, af.core_tags_digest, af.audio_hash,
           case when af.tags_raw->'common'->'track'->>'no' ~ '^[0-9]+$' then (af.tags_raw->'common'->'track'->>'no')::int end as track_no,
           case when af.tags_raw->'common'->'disk'->>'no' ~ '^[0-9]+$' then (af.tags_raw->'common'->'disk'->>'no')::int end as disc_no,
           (extract(epoch from af.first_seen_at) * 1000)::float8 as first_seen_ms,
           (extract(epoch from af.last_seen_at) * 1000)::float8 as last_seen_ms
      from audio_files af where ${where}`) as unknown as Array<Record<string, any>>;
  return rows.map((r) => ({
    id: r['id'], scanRootId: r['scan_root_id'], relPath: r['rel_path'], sizeBytes: r['size_bytes'], mtime: r['mtime'],
    inode: r['inode'], durationMs: r['duration_ms'], coreTagsDigest: r['core_tags_digest'], audioHash: r['audio_hash'],
    trackNo: r['track_no'], discNo: r['disc_no'],
    firstSeenAt: new Date(r['first_seen_ms']), lastSeenAt: new Date(r['last_seen_ms']),
  }));
}

const dirsOf = (fs: MatchFile[]) => {
  const m = new Map<string, DirRef>();
  for (const f of fs) m.set(`${f.scanRootId}\n${relDirname(f.relPath)}`, { scanRootId: f.scanRootId, dirPath: relDirname(f.relPath) });
  return [...m.values()];
};

/** Every row of these folders matching `cond` (the 80% denominator, the edition guard's extras). */
async function rowsInDirs(ctx: Pick<WorkerContext, 'sql'>, libraryId: string, dirs: DirRef[], cond: Fragment): Promise<MatchFile[]> {
  if (dirs.length === 0) return [];
  return loadMatchFiles(ctx, ctx.sql`af.library_id = ${libraryId} and ${cond} and (af.scan_root_id, ${ctx.sql.unsafe(sqlDirname('af'))}) in
    (select * from unnest(${dirs.map((d) => d.scanRootId)}::uuid[], ${dirs.map((d) => d.dirPath)}::text[]))`);
}

const uniqById = (fs: MatchFile[]) => [...new Map(fs.map((f) => [f.id, f])).values()];

/** Deadlock and serialization failures: the pair is worth one more try. */
const RETRYABLE = new Set(['40P01', '40001']);

/**
 * One merge, retried once on a deadlock or serialization failure. Any error
 * that remains is logged and the pair left alone: one failed pair never
 * aborts the rest of the reconcile.
 */
async function mergeOnce(ctx: Pick<WorkerContext, 'sql' | 'logger'>, req: MergeRequest): Promise<MergeOutcome | { kind: 'failed'; reason: string }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await mergeFilePair(ctx, req);
    } catch (err) {
      const code = pgErrorCode(err);
      if (attempt === 1 && code !== undefined && RETRYABLE.has(code)) continue;
      return { kind: 'failed', reason: `${code ?? 'error'}: ${errorMessage(err)}` };
    }
  }
}

/** Runs the plan's merges one transaction each and folds them into a result. */
export async function runMerges(
  ctx: WorkerContext, tier: Tier, olds: MatchFile[], freshs: MatchFile[], walkStart: Date | null, allowAbsorb: boolean,
): Promise<ReconcileResult> {
  const plan = planPairs(tier, olds, freshs);
  const out = emptyReconcile();
  out.possibleMoves = plan.possibleMoves.length;
  const oldById = new Map(olds.map((o) => [o.id, o]));
  const moves = new Map<string, MoveRecord>();
  const dirs = new Map<string, DirRef>();
  for (const p of plan.pairs) {
    const o = oldById.get(p.oldId)!;
    const res = await mergeOnce(ctx, { oldId: p.oldId, freshId: p.freshId, oldAt: { scanRootId: o.scanRootId, relPath: o.relPath }, walkStart, allowAbsorb });
    if (res.kind === 'skipped' || res.kind === 'failed') {
      const log = res.kind === 'failed' ? ctx.logger.warn.bind(ctx.logger) : ctx.logger.info.bind(ctx.logger);
      log({ tier, oldId: p.oldId, freshId: p.freshId, reason: res.reason }, 'files.reconcile: pair left alone');
      out.possibleMoves += 1;
      continue;
    }
    out.merged += 1;
    out.outcomes.push(res);
    out.mergedFreshIds.push(p.freshId);
    if (res.reparse) out.reparseIds.push(res.oldId);
    const fromDir = relDirname(res.from.relPath);
    const toDir = relDirname(res.to.relPath);
    const k = `${res.from.scanRootId}\n${fromDir}\n${res.to.scanRootId}\n${toDir}`;
    const m = moves.get(k) ?? { fromRootId: res.from.scanRootId, fromDir, toRootId: res.to.scanRootId, toDir, files: 0 };
    m.files += 1;
    moves.set(k, m);
    dirs.set(`${res.from.scanRootId}\n${fromDir}`, { scanRootId: res.from.scanRootId, dirPath: fromDir });
    dirs.set(`${res.to.scanRootId}\n${toDir}`, { scanRootId: res.to.scanRootId, dirPath: toDir });
  }
  out.moves = [...moves.values()].sort((a, b) => b.files - a.files);
  out.reclusterDirs = [...dirs.values()];
  return out;
}

/**
 * Tier 1: this walk's vanished rows (and the library's missing rows of the
 * sizes this walk added) against this walk's new rows (and any row of the
 * library, any root, first seen after them; Ruling 17). A row on the old side
 * is never a candidate on the new side: it is the one that vanished.
 */
export async function reconcileTier1(ctx: WorkerContext, root: WalkRoot, walk: WalkTreeResult): Promise<ReconcileResult> {
  const sql = ctx.sql;
  const unseenIds = walk.unseen.map((u) => u.id);
  if (unseenIds.length === 0 && walk.insertedIds.length === 0) return emptyReconcile();
  const unseenSizes = [...new Set(walk.unseen.map((u) => u.sizeBytes).filter((s): s is number => s !== null))];
  const inserted = walk.insertedIds.length
    ? await loadMatchFiles(ctx, sql`af.id = any(${walk.insertedIds}::uuid[])`) : [];
  const insertedSizes = [...new Set(inserted.map((f) => f.sizeBytes).filter((s): s is number => s !== null))];

  let olds = [
    ...(unseenIds.length ? await loadMatchFiles(ctx, sql`af.id = any(${unseenIds}::uuid[])`) : []),
    ...(insertedSizes.length ? await loadMatchFiles(ctx, sql`af.library_id = ${root.libraryId} and af.status = 'missing'
                                                             and af.size_bytes = any(${insertedSizes}::bigint[])`) : []),
  ];
  if (olds.length === 0) return emptyReconcile();
  const earliest = new Date(Math.min(...olds.map((o) => o.lastSeenAt.getTime()))).toISOString();
  let freshs = [
    ...inserted,
    ...(unseenSizes.length ? await loadMatchFiles(ctx, sql`af.library_id = ${root.libraryId} and af.status in ('present', 'error')
                                                           and af.size_bytes = any(${unseenSizes}::bigint[])
                                                           and af.first_seen_at >= ${earliest}::timestamptz
                                                           and not (af.id = any(${unseenIds}::uuid[]))`) : []),
  ];
  // Whole folders on both sides (Ruling 2; edition guard extras).
  olds = uniqById([...olds, ...await rowsInDirs(ctx, root.libraryId, dirsOf(olds), sql`af.status = 'missing'`)]);
  const oldIds = new Set(olds.map((o) => o.id));
  freshs = uniqById([...freshs, ...await rowsInDirs(ctx, root.libraryId, dirsOf(freshs),
    sql`af.status in ('present', 'error') and af.first_seen_at >= ${earliest}::timestamptz`)])
    .filter((f) => !oldIds.has(f.id));
  return runMerges(ctx, 1, olds, freshs, walk.walkStart, false);
}

export function describeMoves(moves: MoveRecord[]): string {
  if (moves.length === 0) return '';
  const total = moves.reduce((n, m) => n + m.files, 0);
  const top = [...moves].sort((a, b) => b.files - a.files)[0]!;
  const name = (d: string) => d === '' ? '(top folder)' : d;
  const rest = moves.length - 1;
  return `moved ${total} file${total === 1 ? '' : 's'}: ${name(top.fromDir)} → ${name(top.toDir)}`
    + (rest > 0 ? ` (and ${rest} more folder${rest === 1 ? '' : 's'})` : '');
}

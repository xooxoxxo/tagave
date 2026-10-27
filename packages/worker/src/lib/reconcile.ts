/**
 * Reconciliation (move-safe scanning §1). Tier 1 runs at the end of each walk
 * (scan.root, scan.dir); Tier 2 when a cluster hold is released (scan.parse,
 * scan.sweep). Both run under one session-level advisory lock per library,
 * taken on a reserved connection and held only for reconcile plus
 * missing-marking (Tier 2 only tries it, never waits), never for the walk: no
 * hours-long transaction, and a "Rescan this folder" never waits behind a
 * full walk, only behind another finish step.
 */
import type postgres from 'postgres';
import type { WorkerContext } from './context.js';
import { pgErrorCode, errorMessage } from './dbErrors.js';
import { relDirname } from './helpers.js';

export { sqlDirname } from './helpers.js';
import { isUnderFailedPath } from './scanFinish.js';
import { mergeFilePair, mergeFilePairs, type MergeDone, type MergeOutcome, type MergeRequest } from './fileMerge.js';
import { planPairs, type MatchFile, type Tier } from './reconcileMatch.js';
import { refreshPlayerAfterMoves, repointSidecarImages } from './moveEffects.js';
import { cancelQueuedIdentify } from './cancelIdentify.js';
import type { WalkRoot, WalkTreeResult } from './walk.js';

export const RECONCILE_LOCK_PREFIX = 'files.reconcile:';

export interface DirRef { scanRootId: string; dirPath: string }
export interface MoveRecord { fromRootId: string; fromDir: string; toRootId: string; toDir: string; files: number }
export interface ReconcileResult {
  merged: number; moves: MoveRecord[]; possibleMoves: number;
  mergedFreshIds: string[]; reparseIds: string[]; reclusterDirs: DirRef[]; outcomes: MergeDone[];
  /** The moved folders' sidecar covers could not be re-pointed: the caller must not drop stale sidecars this run. */
  sidecarRepointFailed: boolean;
}

export function emptyReconcile(): ReconcileResult {
  return { merged: 0, moves: [], possibleMoves: 0, mergedFreshIds: [], reparseIds: [], reclusterDirs: [], outcomes: [], sidecarRepointFailed: false };
}

/**
 * Runs fn while holding the library's reconcile lock. When fn throws, its
 * error is what the caller sees (an unlock failure next to it is only
 * logged); the reserved connection always goes back to the pool.
 */
export async function withLibraryLock<T>(
  ctx: Pick<WorkerContext, 'sql'> & { logger?: Pick<WorkerContext['logger'], 'warn'> },
  libraryId: string, fn: () => Promise<T>,
): Promise<T> {
  const out = await runLocked(ctx, libraryId, false, fn);
  return (out as { locked: true; value: T }).value;
}

/**
 * withLibraryLock without the wait: when another session holds the lock, fn
 * does not run and `{ locked: false }` comes back at once. For callers that
 * must not park a pooled connection behind a full scan's finish step
 * (scan.parse, scan.sweep). Never call it, or withLibraryLock, inside fn:
 * the lock is per session and the nested call would take a second one.
 */
export async function tryWithLibraryLock<T>(
  ctx: Pick<WorkerContext, 'sql'> & { logger?: Pick<WorkerContext['logger'], 'warn'> },
  libraryId: string, fn: () => Promise<T>,
): Promise<{ locked: true; value: T } | { locked: false }> {
  return runLocked(ctx, libraryId, true, fn);
}

async function runLocked<T>(
  ctx: Pick<WorkerContext, 'sql'> & { logger?: Pick<WorkerContext['logger'], 'warn'> },
  libraryId: string, tryOnly: boolean, fn: () => Promise<T>,
): Promise<{ locked: true; value: T } | { locked: false }> {
  const key = RECONCILE_LOCK_PREFIX + libraryId;
  const conn = await ctx.sql.reserve();
  try {
    if (tryOnly) {
      const [got] = (await conn`select pg_try_advisory_lock(hashtextextended(${key}, 0)) as locked`) as unknown as Array<{ locked: boolean }>;
      if (got?.locked !== true) return { locked: false };
    } else {
      await conn`select pg_advisory_lock(hashtextextended(${key}, 0))`;
    }
    let out: { ok: true; value: T } | { ok: false; err: unknown };
    try {
      out = { ok: true, value: await fn() };
    } catch (err) {
      out = { ok: false, err };
    }
    try {
      const [row] = (await conn`select pg_advisory_unlock(hashtextextended(${key}, 0)) as unlocked`) as unknown as Array<{ unlocked: boolean }>;
      if (row?.unlocked !== true) ctx.logger?.warn({ libraryId }, 'files.reconcile: lock was not held at unlock');
    } catch (unlockErr) {
      if (out.ok) throw unlockErr;
      ctx.logger?.warn({ libraryId, err: errorMessage(unlockErr) }, 'files.reconcile: unlock failed after an error');
    }
    if (!out.ok) throw out.err;
    return { locked: true, value: out.value };
  } finally {
    conn.release();
  }
}


type Fragment = postgres.PendingQuery<postgres.Row[]>;

/** The client reads timestamptz as text, so times come back as epoch milliseconds. */
export async function loadMatchFiles(ctx: Pick<WorkerContext, 'sql'>, where: Fragment): Promise<MatchFile[]> {
  return matchRows(ctx, ctx.sql`audio_files af where ${where}`);
}

/** `source` is everything after FROM; it must expose the audio_files row as `af`. */
async function matchRows(ctx: Pick<WorkerContext, 'sql'>, source: Fragment): Promise<MatchFile[]> {
  const rows = (await ctx.sql`
    select af.id, af.scan_root_id, af.rel_path, af.size_bytes::float8 as size_bytes, af.mtime::float8 as mtime, af.inode,
           af.duration_ms, af.core_tags_digest, af.audio_hash,
           case when af.tags_raw->'common'->'track'->>'no' ~ '^[0-9]+$' then (af.tags_raw->'common'->'track'->>'no')::int end as track_no,
           case when af.tags_raw->'common'->'disk'->>'no' ~ '^[0-9]+$' then (af.tags_raw->'common'->'disk'->>'no')::int end as disc_no,
           (extract(epoch from af.first_seen_at) * 1000)::float8 as first_seen_ms,
           (extract(epoch from af.last_seen_at) * 1000)::float8 as last_seen_ms
      from ${source}`) as unknown as Array<Record<string, any>>;
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

/**
 * Every row of these folders matching `cond` (the 80% denominator, the edition
 * guard's extras). Same grouping as sqlDirname, but written so each folder is
 * one range scan of idx_audio_files_relpath_prefix (scan_root_id, rel_path
 * text_pattern_ops): `dir/` <= rel_path < `dir0` ('0' follows '/'), then no
 * further '/'. `offset 0` fences the lateral so the outer filters are not
 * pushed in: with them the planner (estimating a run-time prefix generically)
 * walked the whole root on idx_audio_files_scan_root, 23 ms against 0.06 ms
 * per folder at 200k rows. Top-level folders ('') have no prefix: one pass over each such
 * root's rows by scan_root_id, keeping paths without a '/'.
 */
export async function rowsInDirs(ctx: Pick<WorkerContext, 'sql'>, libraryId: string, dirs: DirRef[], cond: Fragment): Promise<MatchFile[]> {
  const sql = ctx.sql;
  const nested = dirs.filter((d) => d.dirPath !== '');
  const topRoots = [...new Set(dirs.filter((d) => d.dirPath === '').map((d) => d.scanRootId))];
  const out: MatchFile[] = [];
  for (let i = 0; i < nested.length; i += DIR_BATCH) {
    const chunk = nested.slice(i, i + DIR_BATCH);
    appendAll(out, await matchRows(ctx, sql`
      unnest(${chunk.map((d) => d.scanRootId)}::uuid[], ${chunk.map((d) => d.dirPath)}::text[]) as d(root_id, dir)
      cross join lateral (
        select * from audio_files x
         where x.scan_root_id = d.root_id
           and x.rel_path ~>=~ (d.dir || '/') and x.rel_path ~<~ (d.dir || '0')
           and strpos(substr(x.rel_path, length(d.dir) + 2), '/') = 0
        offset 0
      ) af
      where af.library_id = ${libraryId} and ${cond}`));
  }
  if (topRoots.length) {
    appendAll(out, await loadMatchFiles(ctx, sql`af.scan_root_id = any(${topRoots}::uuid[]) and strpos(af.rel_path, '/') = 0
                                               and af.library_id = ${libraryId} and ${cond}`));
  }
  return out;
}
const DIR_BATCH = 500;

/** out.push(...xs) spreads xs into call arguments and throws past ~125k; a loop does not. */
function appendAll<T>(out: T[], xs: readonly T[]): void {
  for (const x of xs) out.push(x);
}

const uniqById = (fs: MatchFile[]) => [...new Map(fs.map((f) => [f.id, f])).values()];

/** Earliest last_seen_at over these rows. A loop, not Math.min(...xs): spreading 125k+ arguments throws. */
export function earliestLastSeen(fs: MatchFile[]): Date {
  let min = Infinity;
  for (const f of fs) { const t = f.lastSeenAt.getTime(); if (t < min) min = t; }
  return new Date(min);
}

/** Deadlock and serialization failures: the pair is worth one more try. */
const RETRYABLE = new Set(['40P01', '40001']);

/**
 * One merge (or one fresh album's merges, in one transaction), retried once
 * on a deadlock or serialization failure. Any error that remains is logged
 * and the pairs left alone: one failed unit never aborts the rest of the
 * reconcile.
 */
async function mergeOnce(ctx: Pick<WorkerContext, 'sql' | 'logger'>, reqs: MergeRequest[]): Promise<Array<MergeOutcome | { kind: 'failed'; reason: string }>> {
  for (let attempt = 1; ; attempt++) {
    try {
      return reqs.length === 1 ? [await mergeFilePair(ctx, reqs[0]!)] : await mergeFilePairs(ctx, reqs);
    } catch (err) {
      const code = pgErrorCode(err);
      if (attempt === 1 && code !== undefined && RETRYABLE.has(code)) continue;
      const failed = { kind: 'failed' as const, reason: `${code ?? 'error'}: ${errorMessage(err)}` };
      return reqs.map(() => failed);
    }
  }
}

/**
 * The plan's pairs in merge units: pairs whose fresh rows share a fresh
 * album form one unit (absorbed together or not at all, review round 1);
 * every other pair is a unit of its own. Read without locks: mergeFilePairs
 * checks the albums again under its locks and falls back when they changed.
 */
async function mergeUnits<T extends { freshId: string }>(ctx: Pick<WorkerContext, 'sql'>, pairs: T[], allowAbsorb: boolean): Promise<T[][]> {
  if (!allowAbsorb || pairs.length < 2) return pairs.map((p) => [p]);
  const rows = (await ctx.sql`
    select distinct audio_file_id::text as file, local_album_id::text as album from local_tracks
     where audio_file_id = any(${pairs.map((p) => p.freshId)}::uuid[]) and local_album_id is not null`) as unknown as Array<{ file: string; album: string }>;
  const parent = pairs.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]!; } return i; };
  const indexOf = new Map(pairs.map((p, i) => [p.freshId, i]));
  const firstOfAlbum = new Map<string, number>();
  for (const r of rows) {
    const i = indexOf.get(r.file);
    if (i === undefined) continue;
    const j = firstOfAlbum.get(r.album);
    if (j === undefined) firstOfAlbum.set(r.album, i);
    else parent[find(i)] = find(j);
  }
  const units = new Map<number, T[]>();
  pairs.forEach((p, i) => {
    const root = find(i);
    const u = units.get(root);
    if (u) u.push(p); else units.set(root, [p]);
  });
  return [...units.values()];
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
  const results: Array<{ p: (typeof plan.pairs)[number]; res: MergeOutcome | { kind: 'failed'; reason: string } }> = [];
  for (const unit of await mergeUnits(ctx, plan.pairs, allowAbsorb)) {
    const reqs = unit.map((p) => {
      const o = oldById.get(p.oldId)!;
      return { oldId: p.oldId, freshId: p.freshId, oldAt: { scanRootId: o.scanRootId, relPath: o.relPath }, walkStart, allowAbsorb };
    });
    const outs = await mergeOnce(ctx, reqs);
    unit.forEach((p, i) => results.push({ p, res: outs[i]! }));
  }
  for (const { p, res } of results) {
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
  // Sidecar covers follow the merged folders before any stale sidecar is dropped
  // (Tier 1: finishWalk drops after this; Tier 2: the old sidecar waited, Ruling 9).
  // The old rows are known gone from their folders (unseen or missing), so they do
  // not make a folder look still occupied.
  // Each effect runs on its own: the merges are committed, so one failing must not skip the other.
  if (out.moves.length > 0) {
    try {
      await repointSidecarImages(ctx, out.moves, olds.map((o) => o.id));
    } catch (error) {
      out.sidecarRepointFailed = true;
      ctx.logger.warn({ tier, error: String(error) }, 'files.reconcile: could not re-point sidecar covers after moves');
    }
  }
  // The player's song ids of moved files are stale (new path); only when it mapped them (Ruling 10).
  try {
    await refreshPlayerAfterMoves(ctx, out.outcomes);
  } catch (error) {
    ctx.logger.warn({ tier, error: String(error) }, 'files.reconcile: could not refresh the player after moves');
  }
  // Albums absorbed into the old ones (destination clustered first): their queued
  // identify jobs would only find them gone. Best effort, like cluster.dir's sweep.
  const removed = out.outcomes.flatMap((o) => o.removedAlbumIds);
  if (removed.length > 0) {
    try { await cancelQueuedIdentify(ctx, removed); } catch (err) { ctx.logger.warn({ err: (err as Error).message }, 'files.reconcile: could not cancel identify jobs'); }
  }
  return out;
}

/**
 * Tier 1: this walk's vanished rows (and the library's missing rows of the
 * sizes this walk added) against this walk's new rows (and any row of the
 * library, any root, first seen after them; Ruling 17). A row on the old side
 * is never a candidate on the new side: it is the one that vanished. Rows
 * under the walk's failed paths never pair: the walk could not read them, so
 * they are neither known gone nor a known new copy (finishWalk keeps them out
 * of missing-marking the same way). On the new side they still count for the
 * edition guard.
 */
export async function reconcileTier1(ctx: WorkerContext, root: WalkRoot, walk: WalkTreeResult): Promise<ReconcileResult> {
  const sql = ctx.sql;
  const walkStart = walk.walkStart.toISOString();
  const failed = new Set(walk.failedPaths);
  const unseen = failed.size ? walk.unseen.filter((u) => !isUnderFailedPath(u.relPath, failed)) : walk.unseen;
  // Old side first. Vanished rows count only while still where the walk saw
  // them and not seen since it began (a concurrent scan.dir may have re-pointed
  // or seen them), so oldAt is the walk's own picture.
  const unseenOlds = unseen.length ? await loadMatchFiles(ctx, sql`
    af.scan_root_id = ${root.id} and af.status in ('present', 'error') and af.last_seen_at < ${walkStart}::timestamptz
    and (af.id, af.rel_path) in (select * from unnest(${unseen.map((u) => u.id)}::uuid[], ${unseen.map((u) => u.relPath)}::text[]))`) : [];
  const missingOlds = walk.insertedIds.length ? await loadMatchFiles(ctx, sql`
    af.library_id = ${root.libraryId} and af.status = 'missing'
    and af.size_bytes in (select i.size_bytes from audio_files i where i.id = any(${walk.insertedIds}::uuid[]))`) : [];
  let olds = uniqById([...unseenOlds, ...missingOlds]);
  if (olds.length === 0) return emptyReconcile();
  const unseenIds = unseenOlds.map((o) => o.id);
  const unseenSizes = [...new Set(unseenOlds.map((u) => u.sizeBytes).filter((s): s is number => s !== null))];
  const earliest = earliestLastSeen(olds).toISOString();
  const inserted = walk.insertedIds.length
    ? await loadMatchFiles(ctx, sql`af.id = any(${walk.insertedIds}::uuid[])`) : [];
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
    .filter((f) => !oldIds.has(f.id))
    // A row the walk could not read may itself be gone, so it never pairs; it still
    // counts for the edition guard (as an extra or a resident, by first_seen_at).
    // Tier 1 pairs only on equal size, so a null size bars it from every pairing.
    .map((f) => f.scanRootId === root.id && isUnderFailedPath(f.relPath, failed) ? { ...f, sizeBytes: null, inode: null } : f);
  return runMerges(ctx, 1, olds, freshs, walk.walkStart, true);
}

/** Tier 2's result; `lockBusy` means it did not run because another session held the library lock. */
export interface Tier2Result extends ReconcileResult { lockBusy: boolean }

/**
 * Tier 2: parsed new rows against the library's missing rows by size +
 * duration + core tag digest, or audio hash when both have one. The old row
 * must already be missing (walkStart null). It takes the library lock with a
 * try-lock: it runs inside scan.parse and scan.sweep, which must not hold a
 * pooled connection while a full scan reconciles. On a busy lock nothing is
 * paired and `lockBusy` is set; the caller keeps the holds and tries again.
 */
export async function reconcileTier2(ctx: WorkerContext, libraryId: string, freshIds: string[]): Promise<Tier2Result> {
  if (freshIds.length === 0) return { ...emptyReconcile(), lockBusy: false };
  const out = await tryWithLibraryLock(ctx, libraryId, async () => {
    const sql = ctx.sql;
    const parsed = await loadMatchFiles(ctx, sql`af.id = any(${freshIds}::uuid[]) and af.library_id = ${libraryId}
                                                 and af.status in ('present', 'error')`);
    if (parsed.length === 0) return emptyReconcile();
    const sizes = [...new Set(parsed.map((f) => f.sizeBytes).filter((s): s is number => s !== null))];
    const hashes = [...new Set(parsed.map((f) => f.audioHash).filter((h): h is string => !!h))];
    let latestMs = -Infinity;
    for (const f of parsed) { const t = f.firstSeenAt.getTime(); if (t > latestMs) latestMs = t; }
    const latest = new Date(latestMs).toISOString();
    let olds = await loadMatchFiles(ctx, sql`af.library_id = ${libraryId} and af.status = 'missing' and af.last_seen_at <= ${latest}::timestamptz
      and (af.size_bytes = any(${sizes}::bigint[]) or af.audio_hash = any(${hashes}::text[]))`);
    if (olds.length === 0) return emptyReconcile();
    const earliest = earliestLastSeen(olds).toISOString();
    olds = uniqById([...olds, ...await rowsInDirs(ctx, libraryId, dirsOf(olds), sql`af.status = 'missing'`)]);
    const freshs = uniqById([...parsed, ...await rowsInDirs(ctx, libraryId, dirsOf(parsed),
      sql`af.status in ('present', 'error') and af.first_seen_at >= ${earliest}::timestamptz`)]);
    return runMerges(ctx, 2, olds, freshs, null, true);
  });
  return out.locked ? { ...out.value, lockBusy: false } : { ...emptyReconcile(), lockBusy: true };
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

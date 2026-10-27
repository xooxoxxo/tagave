import { eq } from 'drizzle-orm';
import { scanRoots, scans } from '@tagave/db';
import type { WorkerContext } from '../lib/context.js';
import { walkRoot, type WalkMode } from '../lib/walk.js';
import { finishNotes } from '../lib/scanFinish.js';
import { describeMoves, type DirRef } from '../lib/reconcile.js';
import { reportProgress } from './progress.js';
import { probeRoot } from './rootsValidate.js';
import { clusterSingletonKey } from '../lib/helpers.js';

export interface ScanRootJobData {
  scanRootId: string;
  /**
   * full (default): stat every file. quick: skip directories whose mtime has
   * not changed since the last scan (scan_dirs); the scheduled poll uses it,
   * the weekly sweep and "Scan now" run full.
   */
  mode?: WalkMode;
  /** set by release B's Missing list › Confirm missing; skips the partly-unmounted hold (always a full walk) */
  confirmMissing?: boolean;
}

const PARSE_BATCH = 50;
/** seconds between a scan that changed files and the gap check it queues */
const GAPS_AFTER_SCAN_S = 15 * 60;
/** directories walked at once — NFS round trips dominate, not CPU */
const WALK_CONCURRENCY = 8;

/**
 * spec LIB-3/LIB-5/LIB-7. Walks the root, indexes new/changed audio files,
 * records sidecars, marks vanished files missing — but only after a complete
 * walk, and never when the root looks unmounted.
 */
export async function scanRootJob(ctx: WorkerContext, data: ScanRootJobData): Promise<void> {
  // confirmMissing always walks in full: a quick walk counts the rows of an unchanged
  // folder as seen, so it would confirm nothing.
  const mode: WalkMode = data.mode === 'quick' && data.confirmMissing !== true ? 'quick' : 'full';
  const rootRows = await ctx.db
    .select()
    .from(scanRoots)
    .where(eq(scanRoots.id, data.scanRootId))
    .limit(1);
  const root = rootRows[0];
  if (!root) throw new Error(`scan root ${data.scanRootId} not found`);
  if (!root.enabled) {
    ctx.logger.info({ scanRootId: root.id }, 'scan root disabled, skipping');
    return;
  }

  const jobRunId = await reportProgress(ctx, null, {
    libraryId: root.libraryId,
    type: 'scan.root',
    subjectType: 'scan_root',
    subjectId: root.id,
    state: 'running',
    message: `${mode} scan of ${root.displayName}`,
  });

  const scanInserted = await ctx.db
    .insert(scans)
    .values({ scanRootId: root.id, status: 'running', stats: { mode } })
    .returning({ id: scans.id });
  const scanRow = scanInserted[0];
  if (!scanRow) throw new Error('scans insert returned no row');
  const scanId = scanRow.id;
  const startedMs = Date.now();

  const fail = async (status: string, message: string) => {
    await ctx.db
      .update(scans)
      .set({ status, finishedAt: new Date(), stats: { mode, error: message } })
      .where(eq(scans.id, scanId));
    await ctx.db
      .update(scanRoots)
      .set({ lastScanAt: new Date(), lastStatus: status })
      .where(eq(scanRoots.id, root.id));
    await reportProgress(ctx, jobRunId, {
      libraryId: root.libraryId, type: 'scan.root', state: 'failed', error: message,
    });
  };

  // LIB-1/LIB-5: probe the root on this host, stamp the validation columns,
  // and abort before anything is marked missing when it is not readable.
  const { status, message: validationMessage, probeWritable } = await probeRoot(root.path, root.writable);
  await ctx.db
    .update(scanRoots)
    .set({ validationStatus: status, validationMessage, validatedAt: new Date(), probeWritable })
    .where(eq(scanRoots.id, root.id));
  if (status !== 'ok') {
    await fail('aborted', `root ${status}: ${validationMessage ?? status}`);
    return;
  }

  let walk;
  try {
    walk = await walkRoot(ctx, root, {
      mode,
      concurrency: WALK_CONCURRENCY,
      confirmMissing: data.confirmMissing === true,
      onProgress: async (filesSeen, dir) => {
        await ctx.db.update(scans).set({ cursor: { lastDir: dir, filesSeen } }).where(eq(scans.id, scanId));
        await reportProgress(ctx, jobRunId, {
          libraryId: root.libraryId, type: 'scan.root', state: 'running',
          done: filesSeen, message: `${filesSeen} files seen`,
        });
      },
    });
  } catch (err) {
    await fail('failed', `walk failed: ${(err as Error).message}`);
    throw err;
  }

  // LIB-5: previously non-empty root that now yields nothing = unmounted share.
  if (walk.looksUnmounted) {
    await fail('aborted', 'root yielded zero files but previously had files — treating as unmounted, nothing marked missing' + finishNotes(walk));
    return;
  }

  // Hand changed files to the parser (which re-clusters their directories);
  // directories that only lost files get re-clustered directly.
  for (let i = 0; i < walk.changedIds.length; i += PARSE_BATCH) {
    await ctx.boss.send('scan.parse', { audioFileIds: walk.changedIds.slice(i, i + PARSE_BATCH) });
  }
  await enqueueReclusters(ctx, root, walk.dirsWithMissing);
  // Old and new folders of every Tier 1 merge (the old one possibly on another
  // root): the moved album follows its files, and a new folder whose merged
  // rows need no re-parse would otherwise never be clustered.
  await enqueueDirs(ctx, root.libraryId, walk.reclusterDirs, { throttle: false });
  // Files came or went: check the gaps again once parsing and clustering have
  // had time to settle, so a task like "find the 4 missing tracks" is crossed
  // out by the scan that saw the files arrive, not by the nightly run. One
  // pending run per library (same key as a retry from the Jobs page).
  if (walk.added + walk.changed + walk.missing > 0) {
    await ctx.boss.send('gaps.recompute', { libraryId: root.libraryId }, {
      singletonKey: `gaps:${root.libraryId}`, startAfter: GAPS_AFTER_SCAN_S,
    });
  }

  const elapsedS = Math.round((Date.now() - startedMs) / 1000);
  const stats = {
    mode,
    filesSeen: walk.filesSeen, added: walk.added, changed: walk.changed, missing: walk.missing,
    errored: walk.errored, sidecars: walk.sidecars, dirsSeen: walk.dirsSeen, dirsSkipped: walk.dirsSkipped,
    formats: walk.formats, elapsedS,
    failedDirs: walk.failedDirs.slice(0, 20), heldMissing: walk.heldMissing, confirmedAfterHold: walk.confirmedAfterHold, reconcileSkipped: walk.reconcileSkipped,
    merged: walk.merged, possibleMoves: walk.possibleMoves, moves: walk.moves.slice(0, 50),
  };
  await ctx.db
    .update(scans)
    .set({ status: 'completed', finishedAt: new Date(), stats, cursor: null })
    .where(eq(scans.id, scanId));
  await ctx.db
    .update(scanRoots)
    .set({ lastScanAt: new Date(), lastStatus: 'completed' })
    .where(eq(scanRoots.id, root.id));
  await reportProgress(ctx, jobRunId, {
    libraryId: root.libraryId, type: 'scan.root', state: 'completed',
    done: walk.filesSeen, total: walk.filesSeen,
    message: `${mode}: ${walk.filesSeen} seen, ${walk.added} added, ${walk.changed} changed, ${walk.missing} missing`
      + (walk.merged ? `, ${describeMoves(walk.moves)}` : '')
      + (walk.possibleMoves ? `, ${walk.possibleMoves} possible move(s) left alone` : '')
      + `, ${walk.dirsSkipped}/${walk.dirsSeen} dirs skipped, ${elapsedS}s` + finishNotes(walk),
  });
  ctx.logger.info({ scanRootId: root.id, ...stats }, 'scan complete');
}

/**
 * One debounced cluster.dir per (root, folder), same key the parser uses.
 * throttle: false drops singletonSeconds (see sendReleasedCluster): the old
 * and new folders of a merge must be clustered even when a cluster.dir for
 * the same folder already completed in the current 30 s slot, or the moved
 * album would keep its old folder and the new one would stay unclustered.
 * The singletonKey under the stately policy still drops a duplicate while
 * one is queued.
 */
export async function enqueueDirs(
  ctx: WorkerContext,
  libraryId: string,
  dirs: DirRef[],
  opts: { startAfter?: number; throttle?: boolean } = {},
): Promise<void> {
  const seen = new Set<string>();
  const startAfter = opts.startAfter ?? 30;
  for (const d of dirs) {
    const k = `${d.scanRootId}\n${d.dirPath}`;
    if (seen.has(k)) continue;
    seen.add(k);
    await ctx.boss.send('cluster.dir', { libraryId, scanRootId: d.scanRootId, dirPath: d.dirPath },
      opts.throttle === false
        ? { singletonKey: clusterSingletonKey(d.scanRootId, d.dirPath), ...(startAfter ? { startAfter } : {}) }
        : { singletonKey: clusterSingletonKey(d.scanRootId, d.dirPath), singletonSeconds: 30, startAfter });
  }
}

/** One debounced cluster.dir per directory of one root. */
export async function enqueueReclusters(
  ctx: WorkerContext,
  root: { id: string; libraryId: string },
  dirs: string[],
  opts: { startAfter?: number } = {},
): Promise<void> {
  await enqueueDirs(ctx, root.libraryId, dirs.map((dirPath) => ({ scanRootId: root.id, dirPath })), opts);
}

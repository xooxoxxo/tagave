import { eq } from 'drizzle-orm';
import { scanRoots, scans } from '@liner/db';
import type { WorkerContext } from '../lib/context.js';
import { walkRoot, type WalkMode } from '../lib/walk.js';
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
}

const PARSE_BATCH = 50;
/** directories walked at once — NFS round trips dominate, not CPU */
const WALK_CONCURRENCY = 8;

/**
 * spec LIB-3/LIB-5/LIB-7. Walks the root, indexes new/changed audio files,
 * records sidecars, marks vanished files missing — but only after a complete
 * walk, and never when the root looks unmounted.
 */
export async function scanRootJob(ctx: WorkerContext, data: ScanRootJobData): Promise<void> {
  const mode: WalkMode = data.mode === 'quick' ? 'quick' : 'full';
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
    await fail('aborted', 'root yielded zero files but previously had files — treating as unmounted, nothing marked missing');
    return;
  }

  // Hand changed files to the parser (which re-clusters their directories);
  // directories that only lost files get re-clustered directly.
  for (let i = 0; i < walk.changedIds.length; i += PARSE_BATCH) {
    await ctx.boss.send('scan.parse', { audioFileIds: walk.changedIds.slice(i, i + PARSE_BATCH) });
  }
  await enqueueReclusters(ctx, root, walk.dirsWithMissing);

  const elapsedS = Math.round((Date.now() - startedMs) / 1000);
  const stats = {
    mode,
    filesSeen: walk.filesSeen, added: walk.added, changed: walk.changed, missing: walk.missing,
    errored: walk.errored, sidecars: walk.sidecars, dirsSeen: walk.dirsSeen, dirsSkipped: walk.dirsSkipped,
    formats: walk.formats, elapsedS,
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
    message: `${mode}: ${walk.filesSeen} seen, ${walk.added} added, ${walk.changed} changed, ${walk.missing} missing, ${walk.dirsSkipped}/${walk.dirsSeen} dirs skipped, ${elapsedS}s`,
  });
  ctx.logger.info({ scanRootId: root.id, ...stats }, 'scan complete');
}

/** One debounced cluster.dir per directory, same key the parser uses. */
export async function enqueueReclusters(
  ctx: WorkerContext,
  root: { id: string; libraryId: string },
  dirs: string[],
  opts: { startAfter?: number } = {},
): Promise<void> {
  for (const dirPath of new Set(dirs)) {
    await ctx.boss.send(
      'cluster.dir',
      { libraryId: root.libraryId, scanRootId: root.id, dirPath },
      { singletonKey: clusterSingletonKey(root.id, dirPath), singletonSeconds: 30, startAfter: opts.startAfter ?? 30 },
    );
  }
}

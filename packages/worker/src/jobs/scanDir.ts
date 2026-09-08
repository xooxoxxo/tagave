/**
 * Rescan one directory (the album page's "Rescan this folder"): the same
 * walk as scan.root confined to a subtree — stat its files, index new ones,
 * mark the vanished ones missing, re-parse what changed (and what failed to
 * parse before), then re-cluster the folder so the album reflects the disk.
 * Seconds, where a root scan is minutes to hours.
 */
import { eq } from 'drizzle-orm';
import { scanRoots } from '@liner/db';
import type { WorkerContext } from '../lib/context.js';
import { walkRoot } from '../lib/walk.js';
import { reportProgress } from './progress.js';
import { probeRoot } from './rootsValidate.js';
import { enqueueReclusters } from './scanRoot.js';

export interface ScanDirJobData {
  scanRootId: string;
  /** NFC rel dir under the root */
  dirPath: string;
  /** who asked — for the job_runs message */
  reason?: string;
}

const PARSE_BATCH = 50;

export async function scanDirJob(ctx: WorkerContext, data: ScanDirJobData): Promise<void> {
  const [root] = await ctx.db.select().from(scanRoots).where(eq(scanRoots.id, data.scanRootId)).limit(1);
  if (!root) throw new Error(`scan root ${data.scanRootId} not found`);
  const dirPath = data.dirPath.replace(/^\/+|\/+$/g, '');

  const jobRunId = await reportProgress(ctx, null, {
    libraryId: root.libraryId,
    type: 'scan.dir',
    subjectType: 'scan_root',
    subjectId: root.id,
    state: 'running',
    message: `rescanning ${dirPath || root.displayName}`,
  });

  // LIB-5: an unmounted share must not turn the folder's files into "missing".
  const probe = await probeRoot(root.path, root.writable);
  if (probe.status !== 'ok') {
    await reportProgress(ctx, jobRunId, {
      libraryId: root.libraryId, type: 'scan.dir', state: 'failed',
      error: `root ${probe.status}: ${probe.message ?? probe.status}`,
    });
    return;
  }

  const started = Date.now();
  let walk;
  try {
    walk = await walkRoot(ctx, root, { mode: 'full', subtree: dirPath, concurrency: 4, reparseErrors: true });
  } catch (err) {
    await reportProgress(ctx, jobRunId, {
      libraryId: root.libraryId, type: 'scan.dir', state: 'failed', error: (err as Error).message,
    });
    throw err;
  }

  for (let i = 0; i < walk.changedIds.length; i += PARSE_BATCH) {
    await ctx.boss.send('scan.parse', { audioFileIds: walk.changedIds.slice(i, i + PARSE_BATCH) });
  }
  // The owner asked for this folder: re-cluster it right away even when
  // nothing changed on disk, plus any directory that lost files.
  await enqueueReclusters(ctx, root, [dirPath, ...walk.dirsWithMissing], { startAfter: walk.changedIds.length ? 20 : 0 });

  const elapsedS = Math.round((Date.now() - started) / 1000);
  const message = walk.subtreeGone
    ? `folder is gone: ${walk.missing} file(s) marked missing`
    : `${walk.filesSeen} seen, ${walk.added} added, ${walk.changed} changed, ${walk.missing} missing, ${elapsedS}s`;
  await reportProgress(ctx, jobRunId, {
    libraryId: root.libraryId, type: 'scan.dir', state: 'completed',
    done: walk.filesSeen, total: walk.filesSeen, message,
  });
  ctx.logger.info({ scanRootId: root.id, dirPath, reason: data.reason ?? null, ...walk, changedIds: walk.changedIds.length }, 'scan.dir complete');
}

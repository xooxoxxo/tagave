import { opendir, stat } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray, ne, notInArray } from 'drizzle-orm';
import { audioFiles, scanRoots, scans, sidecarFiles } from '@liner/db';
import type { WorkerContext } from '../lib/context.js';
import {
  isAudioFile, sidecarKind, storagePath, extOf,
} from '../lib/helpers.js';
import { reportProgress } from './progress.js';

export interface ScanRootJobData {
  scanRootId: string;
}

interface WalkedFile {
  /** Exact on-disk absolute path — the only string safe to open. */
  absPath: string;
  /** NFC-normalized path relative to the root — the storage identity. */
  relPath: string;
  sizeBytes: number;
  mtime: number;
}

const BATCH = 500;
const PARSE_BATCH = 50;

/**
 * spec LIB-3/LIB-5/LIB-7. Walks the root, indexes new/changed audio files,
 * records sidecars, marks vanished files missing — but only after a complete
 * walk, and never when the root looks unmounted.
 */
export async function scanRootJob(ctx: WorkerContext, data: ScanRootJobData): Promise<void> {
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
    message: `scanning ${root.displayName}`,
  });

  const scanInserted = await ctx.db
    .insert(scans)
    .values({ scanRootId: root.id, status: 'running' })
    .returning({ id: scans.id });
  const scanRow = scanInserted[0];
  if (!scanRow) throw new Error('scans insert returned no row');
  const scanId = scanRow.id;
  const startedMs = Date.now();

  const fail = async (status: string, message: string) => {
    await ctx.db
      .update(scans)
      .set({ status, finishedAt: new Date(), stats: { error: message } })
      .where(eq(scans.id, scanId));
    await ctx.db
      .update(scanRoots)
      .set({ lastScanAt: new Date(), lastStatus: status })
      .where(eq(scanRoots.id, root.id));
    await reportProgress(ctx, jobRunId, {
      libraryId: root.libraryId, type: 'scan.root', state: 'failed', error: message,
    });
  };

  // LIB-5: an unreadable root aborts before anything is marked missing.
  try {
    const d = await opendir(root.path);
    await d.close();
  } catch (err) {
    await fail('aborted', `root unreadable: ${(err as Error).message}`);
    return;
  }

  const existing = await ctx.db
    .select({
      id: audioFiles.id,
      relPath: audioFiles.relPath,
      sizeBytes: audioFiles.sizeBytes,
      mtime: audioFiles.mtime,
      status: audioFiles.status,
    })
    .from(audioFiles)
    .where(eq(audioFiles.scanRootId, root.id));
  const byRelPath = new Map(existing.map((r) => [r.relPath, r]));

  const stats = {
    filesSeen: 0, added: 0, changed: 0, missing: 0, errored: 0, sidecars: 0,
    formats: {} as Record<string, number>,
  };
  const seen = new Set<string>();
  const changedIds: string[] = [];
  const seenSidecars: { relPath: string; kind: string; sizeBytes: number; mtime: number }[] = [];
  let pendingInserts: WalkedFile[] = [];

  const flushInserts = async () => {
    if (pendingInserts.length === 0) return;
    const rows = pendingInserts.map((f) => ({
      libraryId: root.libraryId,
      scanRootId: root.id,
      relPath: f.relPath,
      sizeBytes: f.sizeBytes,
      mtime: f.mtime,
      status: 'present',
    }));
    const inserted = await ctx.db
      .insert(audioFiles)
      .values(rows)
      .onConflictDoUpdate({
        target: [audioFiles.scanRootId, audioFiles.relPath],
        set: { status: 'present', lastSeenAt: new Date() },
      })
      .returning({ id: audioFiles.id });
    changedIds.push(...inserted.map((r) => r.id));
    pendingInserts = [];
  };

  // Iterative DFS. Dirent names are used verbatim for fs calls; only the
  // stored rel_path is normalized (decisions doc gotcha #1).
  const dirStack: string[] = [root.path];
  let filesSinceCursor = 0;
  try {
    while (dirStack.length > 0) {
      const dirAbs = dirStack.pop() as string;
      let entries;
      try {
        entries = await opendir(dirAbs);
      } catch (err) {
        ctx.logger.warn({ dir: dirAbs, err: (err as Error).message }, 'unreadable directory, skipping');
        stats.errored += 1;
        continue;
      }
      for await (const ent of entries) {
        const absPath = path.join(dirAbs, ent.name);
        if (ent.isDirectory()) {
          if (!ent.name.startsWith('.')) dirStack.push(absPath);
          continue;
        }
        if (!ent.isFile()) continue;
        const relPath = storagePath(path.relative(root.path, absPath));

        if (isAudioFile(ent.name)) {
          let st;
          try {
            st = await stat(absPath);
          } catch (err) {
            ctx.logger.warn({ file: absPath, err: (err as Error).message }, 'stat failed');
            stats.errored += 1;
            continue;
          }
          stats.filesSeen += 1;
          const fmt = extOf(ent.name).slice(1);
          stats.formats[fmt] = (stats.formats[fmt] ?? 0) + 1;
          seen.add(relPath);

          const prior = byRelPath.get(relPath);
          const mtimeS = Math.floor(st.mtimeMs / 1000);
          if (!prior) {
            stats.added += 1;
            pendingInserts.push({ absPath, relPath, sizeBytes: st.size, mtime: mtimeS });
          } else if (prior.sizeBytes !== st.size || prior.mtime !== mtimeS || prior.status === 'missing' || prior.status === 'archived') {
            stats.changed += 1;
            await ctx.db
              .update(audioFiles)
              .set({ sizeBytes: st.size, mtime: mtimeS, status: 'present', lastSeenAt: new Date() })
              .where(eq(audioFiles.id, prior.id));
            changedIds.push(prior.id);
          } else {
            await ctx.db
              .update(audioFiles)
              .set({ lastSeenAt: new Date() })
              .where(eq(audioFiles.id, prior.id));
          }
          if (pendingInserts.length >= BATCH) await flushInserts();

          filesSinceCursor += 1;
          if (filesSinceCursor >= 5000) {
            filesSinceCursor = 0;
            await ctx.db
              .update(scans)
              .set({ cursor: { lastDir: storagePath(path.relative(root.path, dirAbs)), filesSeen: stats.filesSeen } })
              .where(eq(scans.id, scanId));
            await reportProgress(ctx, jobRunId, {
              libraryId: root.libraryId, type: 'scan.root', state: 'running',
              done: stats.filesSeen, message: `${stats.filesSeen} files seen`,
            });
          }
        } else {
          const kind = sidecarKind(ent.name);
          if (kind) {
            try {
              const st = await stat(absPath);
              seenSidecars.push({ relPath, kind, sizeBytes: st.size, mtime: Math.floor(st.mtimeMs / 1000) });
              stats.sidecars += 1;
            } catch {
              /* sidecar stat failures are not worth aborting anything */
            }
          }
        }
      }
    }
    await flushInserts();
  } catch (err) {
    await fail('failed', `walk failed: ${(err as Error).message}`);
    throw err;
  }

  // LIB-5: previously non-empty root that now yields nothing = unmounted share.
  if (stats.filesSeen === 0 && existing.length > 0) {
    await fail('aborted', 'root yielded zero files but previously had files — treating as unmounted, nothing marked missing');
    return;
  }

  // Complete walk: anything indexed but unseen is now missing.
  const unseenIds = existing
    .filter((r) => !seen.has(r.relPath) && r.status !== 'missing' && r.status !== 'archived')
    .map((r) => r.id);
  for (let i = 0; i < unseenIds.length; i += BATCH) {
    const chunk = unseenIds.slice(i, i + BATCH);
    await ctx.db.update(audioFiles).set({ status: 'missing' }).where(inArray(audioFiles.id, chunk));
  }
  stats.missing = unseenIds.length;

  // Sidecars: replace the root's inventory (small table, simplest correct move).
  await ctx.db.delete(sidecarFiles).where(eq(sidecarFiles.scanRootId, root.id));
  for (let i = 0; i < seenSidecars.length; i += BATCH) {
    const chunk = seenSidecars.slice(i, i + BATCH).map((s) => ({
      libraryId: root.libraryId, scanRootId: root.id, ...s,
    }));
    if (chunk.length > 0) await ctx.db.insert(sidecarFiles).values(chunk);
  }

  // Hand changed files to the parser.
  for (let i = 0; i < changedIds.length; i += PARSE_BATCH) {
    await ctx.boss.send('scan.parse', { audioFileIds: changedIds.slice(i, i + PARSE_BATCH) });
  }

  const elapsedS = Math.round((Date.now() - startedMs) / 1000);
  await ctx.db
    .update(scans)
    .set({ status: 'completed', finishedAt: new Date(), stats: { ...stats, elapsedS }, cursor: null })
    .where(eq(scans.id, scanId));
  await ctx.db
    .update(scanRoots)
    .set({ lastScanAt: new Date(), lastStatus: 'completed' })
    .where(eq(scanRoots.id, root.id));
  await reportProgress(ctx, jobRunId, {
    libraryId: root.libraryId, type: 'scan.root', state: 'completed',
    done: stats.filesSeen, total: stats.filesSeen,
    message: `${stats.filesSeen} seen, ${stats.added} added, ${stats.changed} changed, ${stats.missing} missing, ${elapsedS}s`,
  });
  ctx.logger.info({ scanRootId: root.id, ...stats, elapsedS }, 'scan complete');
}

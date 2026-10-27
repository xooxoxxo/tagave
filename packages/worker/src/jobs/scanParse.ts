import path from 'node:path';
import { access } from 'node:fs/promises';
import { eq, inArray } from 'drizzle-orm';
import { files, scanRoots } from '@tagave/db';
import { fileTypeHandler, noNul } from '@tagave/core/files';
import type { WorkerContext } from '../lib/context.js';
import { relDirname, tagsDigest } from '../lib/helpers.js';
import { releaseReadyHolds, sendReleasedGrouping } from '../lib/clusterHold.js';
import { groupingQueue, sendGrouping } from '../lib/appFiles.js';

export interface ScanParseJobData {
  /** files ids (the key keeps its old name: jobs queued before 0058 carry it) */
  audioFileIds: string[];
}

/**
 * The stored rel_path is NFC, but the bytes on disk may be NFD (or the exact
 * NFC). Try the stored spelling, then both normalization forms — the same
 * discipline the archive-cleaning tooling needed (decisions doc gotcha #1).
 */
export async function openablePath(rootPath: string, relPath: string): Promise<string | null> {
  const candidates = [relPath, relPath.normalize('NFD'), relPath.normalize('NFC')];
  for (const cand of candidates) {
    const abs = path.join(rootPath, cand);
    try {
      await access(abs);
      return abs;
    } catch {
      /* try next spelling */
    }
  }
  return null;
}

/** spec LIB-2: each file read by its own file-type handler (audio: properties
 * + full tag snapshot); errors are per-file, never batch-fatal. */
export async function scanParseJob(ctx: WorkerContext, data: ScanParseJobData): Promise<void> {
  if (!data.audioFileIds || data.audioFileIds.length === 0) return;

  const rows = await ctx.db
    .select({
      id: files.id,
      relPath: files.relPath,
      scanRootId: files.scanRootId,
      libraryId: files.libraryId,
      handler: files.handler,
    })
    .from(files)
    .where(inArray(files.id, data.audioFileIds));
  if (rows.length === 0) return;

  const rootIds = [...new Set(rows.map((r) => r.scanRootId))];
  const roots = await ctx.db
    .select({ id: scanRoots.id, path: scanRoots.path })
    .from(scanRoots)
    .where(inArray(scanRoots.id, rootIds));
  const rootPathById = new Map(roots.map((r) => [r.id, r.path]));

  // Every folder a parsed (or failed) row is in may have a hold to release;
  // each is sent to the grouping job of its files' app (the gate: music's
  // folders to cluster.dir, books' to books.group, a handler no app groups
  // nowhere).
  const dirsTouched = new Map<string, { libraryId: string; scanRootId: string }>();
  const dirsToGroup = new Map<string, Map<string, { libraryId: string; scanRootId: string }>>(); // queue -> folders
  const touch = (row: (typeof rows)[number]) => {
    const key = `${row.scanRootId}\n${relDirname(row.relPath)}`;
    const info = { libraryId: row.libraryId, scanRootId: row.scanRootId };
    dirsTouched.set(key, info);
    const queue = groupingQueue(row.handler);
    if (queue) dirsToGroup.set(queue, (dirsToGroup.get(queue) ?? new Map()).set(key, info));
  };
  const failed = (id: string, parseError: string) =>
    ctx.db.update(files).set({ status: 'error', parseError }).where(eq(files.id, id));

  for (const row of rows) {
    const rootPath = rootPathById.get(row.scanRootId);
    if (!rootPath) continue;

    const abs = await openablePath(rootPath, row.relPath);
    if (!abs) {
      await failed(row.id, 'file not reachable under any normalization form');
      // An unreachable file errored too (it counts as parsed), so its folder's hold may be ready.
      touch(row);
      continue;
    }

    const handler = fileTypeHandler(row.handler);
    if (!handler) {
      // A row of a handler this build does not carry (written by a newer one): it cannot be read here.
      await failed(row.id, `no file-type handler "${row.handler}" in this version`);
      touch(row);
      continue;
    }
    try {
      const { columns, metadata } = await handler.parse(abs);
      await ctx.db
        .update(files)
        .set({
          ...columns,
          tagsRaw: metadata,
          tagsDigest: tagsDigest(metadata),
          coreTagsDigest: handler.identityDigest(metadata),
          tagsReadAt: new Date(),
          status: 'present',
          parseError: null,
        })
        .where(eq(files.id, row.id));
    } catch (err) {
      // a parser message can quote the file's bytes; Postgres text cannot hold NUL
      await failed(row.id, noNul(`${(err as Error).name ?? 'Error'}: ${(err as Error).message}`)!.slice(0, 2000));
    }
    touch(row);
  }

  // Folders whose held rows are now all parsed: release them (Tier 2 runs
  // there) before their grouping job is sent below. Their sends skip the
  // 30 s throttle slot (see sendReleasedGrouping); a released folder comes
  // back once per app whose files it holds, with that app's queue.
  const touched = [...dirsTouched].map(([key, info]) => ({ ...info, dirPath: key.split('\n')[1] ?? '' }));
  const released = await releaseReadyHolds(ctx, touched);
  for (const d of released) dirsToGroup.get(d.queue)?.delete(`${d.scanRootId}\n${d.dirPath}`);
  for (const d of released) await sendReleasedGrouping(ctx, d, 30);

  // Debounced grouping of every touched directory (singleton per dir and queue).
  for (const [queue, dirs] of dirsToGroup) {
    for (const [key, info] of dirs) {
      const dirPath = key.split('\n')[1] ?? '';
      await sendGrouping(ctx, { ...info, dirPath, queue }, { singletonSeconds: 30, startAfter: 30 });
    }
  }
}


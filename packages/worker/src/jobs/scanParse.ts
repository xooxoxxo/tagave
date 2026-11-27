import path from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { files, scanRoots } from '@tagave/db';
import { fileTypeHandler, noNul, type ParsedFile } from '@tagave/core/files';
import type { WorkerContext } from '../lib/context.js';
import { relDirname, tagsDigest } from '../lib/helpers.js';
import { releaseReadyHolds, sendReleasedGrouping } from '../lib/clusterHold.js';
import { groupingQueue, sendGrouping } from '../lib/appFiles.js';
import { fileGate } from '../lib/fileGate.js';
import { FolderOfflineError, isAbsent, isGateFailure } from '../lib/folderOffline.js';

export interface ScanParseJobData {
  /** files ids (the key keeps its old name: jobs queued before 0058 carry it) */
  audioFileIds: string[];
  /** The file whose offline answer last parked this batch (ruling R34); kept in the parked row's data. */
  hung?: HungFile;
}

/**
 * Ruling R34: one file that hangs (a FIFO indexed as a track) or answers EIO
 * on a live share parks its batch, the watch reads the root online and sends
 * it again, and it hangs again, for good. `parks` counts the parks on this
 * file while the root read online throughout; `at` is the database's time of
 * the last one. A reading of offline or not connected since then (the root's
 * reach_since moved) is a real outage: the count starts again.
 */
export interface HungFile { fileId: string; parks: number; at: string }

/**
 * Re-parks on one file (parks after the first), its root online throughout,
 * before that file gets its error and the batch goes on: the run after the
 * third re-park.
 */
export const HUNG_REPARKS_MAX = 3;
export const HUNG_FILE_ERROR = 'The file did not answer while its music folder was online';

/**
 * The root's reading: `online` now (unknown counts online), `stayed` online
 * with no change of reading since `at` (the last park), and the database's time.
 */
async function rootReading(ctx: Pick<WorkerContext, 'sql'>, rootId: string, at: string | null): Promise<{ online: boolean; stayed: boolean; now: string }> {
  const [row] = await ctx.sql<{ online: boolean; stayed: boolean; now: string }[]>`
    select reach not in ('offline', 'unmounted') as online,
           (reach not in ('offline', 'unmounted') and ${at}::timestamptz is not null
            and (reach_since is null or reach_since <= ${at}::timestamptz)) as stayed,
           now()::text as now
      from scan_roots where id = ${rootId}`;
  return { online: row?.online === true, stayed: row?.stayed === true, now: row?.now ?? new Date().toISOString() };
}

/**
 * An offline answer for this file's own call. True when the file gets its
 * error instead (it parked the batch once and then HUNG_REPARKS_MAX times
 * more, its root online throughout): the batch goes on. Else the park is counted in `data.hung`
 * (the parked row keeps it) and the caller rethrows. A root read offline or
 * not connected never counts.
 */
async function hungFile(ctx: WorkerContext, data: ScanParseJobData, fileId: string, rootId: string): Promise<boolean> {
  const prev = data.hung?.fileId === fileId ? data.hung : null;
  const { online, stayed, now } = await rootReading(ctx, rootId, prev?.at ?? null);
  if (prev && stayed && prev.parks > HUNG_REPARKS_MAX) {
    delete data.hung;
    return true;
  }
  data.hung = { fileId, parks: !online ? 0 : prev && stayed ? prev.parks + 1 : 1, at: now };
  return false;
}

/**
 * The stored rel_path is NFC, but the bytes on disk may be NFD (or the exact
 * NFC). Try the stored spelling, then both normalization forms — the same
 * discipline the archive-cleaning tooling needed (decisions doc gotcha #1).
 * Through the file gate for the root `rootId`. Only an absent spelling
 * (isAbsent) tries the next; anything else (an offline folder, a failed
 * helper, a closed gate) throws, never "not reachable".
 */
export async function openablePath(rootId: string, rootPath: string, relPath: string): Promise<string | null> {
  const candidates = [relPath, relPath.normalize('NFD'), relPath.normalize('NFC')];
  for (const cand of candidates) {
    const abs = path.join(rootPath, cand);
    try {
      await fileGate().run(rootId, { op: 'access', path: abs });
      return abs;
    } catch (err) {
      if (!isAbsent(err)) throw err;
      /* try next spelling */
    }
  }
  return null;
}

/** spec LIB-2: each file read by its own file-type handler (audio: properties
 * + full tag snapshot); errors are per-file, never batch-fatal. The read is
 * the gate's `parse` op, in a file helper. An offline folder is not a file's
 * error: it stops the batch (the files parsed so far keep their rows) and
 * the job parks. */
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

    // An offline answer for this file while its root reads online (R34): after
    // HUNG_REPARKS_MAX re-parks the file gets its error and the rest of the batch goes on.
    const hungHere = async (err: unknown): Promise<boolean> => {
      if (!(err instanceof FolderOfflineError) || err.scanRootId !== row.scanRootId) return false;
      if (!(await hungFile(ctx, data, row.id, row.scanRootId))) return false;
      ctx.logger.warn({ fileId: row.id, scanRootId: row.scanRootId }, 'scan.parse: one file did not answer on a live music folder; marked with an error');
      await failed(row.id, HUNG_FILE_ERROR);
      touch(row);
      return true;
    };

    let abs: string | null;
    try {
      abs = await openablePath(row.scanRootId, rootPath, row.relPath);
    } catch (err) {
      if (await hungHere(err)) continue;
      throw err;
    }
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
      const { columns, metadata } = await fileGate().run<ParsedFile>(row.scanRootId, { op: 'parse', handlerId: handler.id, path: abs });
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
      // the share offline, or the gate failed: not the file's error (unless R34: one file on a live share)
      if (await hungHere(err)) continue;
      if (err instanceof FolderOfflineError || isGateFailure(err)) throw err;
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


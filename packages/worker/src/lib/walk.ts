/**
 * The filesystem walk behind scan.root and scan.dir (spec LIB-3/LIB-5/LIB-7).
 *
 * One code path, three shapes:
 * - full:  every directory, one stat per audio file and sidecar (the
 *          original behaviour, now with a bounded number of directories in
 *          flight — NFS is latency-bound, so parallel readdir/stat is where
 *          the time goes).
 * - quick: a directory whose mtime matches scan_dirs is not entered for
 *          files: its indexed files count as seen and its sidecars carry
 *          over. Adding, removing or renaming an entry bumps the directory
 *          mtime; an in-place edit does not, which the weekly full scan
 *          still catches (and Liner's own tag writes are journaled).
 * - subtree: only the given directory and what is below it (the album
 *          page's "Rescan this folder"); missing detection is confined to
 *          that subtree.
 *
 * Nothing is marked missing unless the walk completed; a root that yields no
 * files while the index has some is reported as unmounted, not emptied.
 * Database writes are batched: one statement per few hundred files instead
 * of one per file.
 */
import { access, opendir, stat } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray, like, lt, or, sql as dsql } from 'drizzle-orm';
import { audioFiles, scanDirs, sidecarFiles } from '@liner/db';
import type { WorkerContext } from './context.js';
import { isAudioFile, sidecarKind, storagePath, extOf, relDirname } from './helpers.js';

export type WalkMode = 'full' | 'quick';

export interface WalkRoot {
  id: string;
  libraryId: string;
  path: string;
}

export interface WalkOptions {
  mode: WalkMode;
  /** NFC rel dir; undefined or '' walks the whole root */
  subtree?: string;
  /** directories in flight at once (default 8) */
  concurrency?: number;
  /** re-parse files whose last parse failed even though size/mtime match */
  reparseErrors?: boolean;
  /** called every ~5000 files with the running count and the current directory */
  onProgress?: (filesSeen: number, dir: string) => void | Promise<void>;
}

export interface WalkResult {
  filesSeen: number;
  added: number;
  changed: number;
  missing: number;
  errored: number;
  sidecars: number;
  dirsSeen: number;
  /** quick mode: directories whose mtime matched and whose files were not stat'ed */
  dirsSkipped: number;
  formats: Record<string, number>;
  /** audio_files ids to hand to scan.parse */
  changedIds: string[];
  /** rel dirs that lost files (nothing re-parses there, so the caller re-clusters them) */
  dirsWithMissing: string[];
  /** the walk saw no files although the index has some: treat as unmounted, nothing was marked */
  looksUnmounted: boolean;
  /** subtree mode: the directory itself is gone */
  subtreeGone: boolean;
}

const INSERT_BATCH = 500;
const UPDATE_BATCH = 2000;
const PROGRESS_EVERY = 5000;

const escapeLike = (s: string) => s.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');

/** Stored paths are NFC; the bytes on disk may be NFD. Find the spelling that opens. */
async function openableDir(rootPath: string, relDir: string): Promise<string | null> {
  if (!relDir) return rootPath;
  for (const cand of [relDir, relDir.normalize('NFD'), relDir.normalize('NFC')]) {
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

class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;
  constructor(private readonly limit: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
  }
  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

export async function walkRoot(ctx: WorkerContext, root: WalkRoot, opts: WalkOptions): Promise<WalkResult> {
  const subtree = storagePath(opts.subtree ?? '').replace(/^\/+|\/+$/g, '');
  const prefix = subtree ? subtree + '/' : '';
  const concurrency = Math.max(1, opts.concurrency ?? 8);
  const startedAt = new Date();

  const scopeLike = prefix ? like(audioFiles.relPath, escapeLike(prefix) + '%') : undefined;
  const existing = await ctx.db
    .select({
      id: audioFiles.id,
      relPath: audioFiles.relPath,
      sizeBytes: audioFiles.sizeBytes,
      mtime: audioFiles.mtime,
      status: audioFiles.status,
    })
    .from(audioFiles)
    .where(and(eq(audioFiles.scanRootId, root.id), scopeLike));
  const byRelPath = new Map(existing.map((r) => [r.relPath, r]));
  const byDir = new Map<string, typeof existing>();
  for (const r of existing) {
    const dir = relDirname(r.relPath);
    const arr = byDir.get(dir);
    if (arr) arr.push(r);
    else byDir.set(dir, [r]);
  }

  // Sidecars of skipped directories carry over; the inventory is rebuilt per scope.
  const sidecarScope = prefix ? like(sidecarFiles.relPath, escapeLike(prefix) + '%') : undefined;
  const existingSidecars = opts.mode === 'quick'
    ? await ctx.db
        .select({ relPath: sidecarFiles.relPath, kind: sidecarFiles.kind, sizeBytes: sidecarFiles.sizeBytes, mtime: sidecarFiles.mtime })
        .from(sidecarFiles)
        .where(and(eq(sidecarFiles.scanRootId, root.id), sidecarScope))
    : [];
  const sidecarsByDir = new Map<string, typeof existingSidecars>();
  for (const s of existingSidecars) {
    const dir = relDirname(s.relPath);
    const arr = sidecarsByDir.get(dir);
    if (arr) arr.push(s);
    else sidecarsByDir.set(dir, [s]);
  }

  // scan_dirs rows in scope: the subtree directory itself and everything below it.
  const dirScope = prefix
    ? or(eq(scanDirs.relPath, subtree), like(scanDirs.relPath, escapeLike(prefix) + '%'))
    : undefined;
  const knownDirs = new Map<string, number>();
  if (opts.mode === 'quick') {
    const rows = await ctx.db
      .select({ relPath: scanDirs.relPath, mtime: scanDirs.mtime })
      .from(scanDirs)
      .where(and(eq(scanDirs.scanRootId, root.id), dirScope));
    for (const r of rows) knownDirs.set(r.relPath, r.mtime);
  }

  const result: WalkResult = {
    filesSeen: 0, added: 0, changed: 0, missing: 0, errored: 0, sidecars: 0,
    dirsSeen: 0, dirsSkipped: 0, formats: {}, changedIds: [], dirsWithMissing: [],
    looksUnmounted: false, subtreeGone: false,
  };
  const seen = new Set<string>();
  const seenSidecars: Array<{ relPath: string; kind: string; sizeBytes: number | null; mtime: number | null }> = [];
  const dirRows: Array<{ relPath: string; mtime: number }> = [];

  // Batched writes. Arrays are shared by the concurrent directory workers;
  // each flush takes a snapshot and the flushes themselves run in order.
  let pendingInserts: Array<{ relPath: string; sizeBytes: number; mtime: number }> = [];
  let pendingChanged: Array<{ id: string; sizeBytes: number; mtime: number }> = [];
  let pendingUnchanged: string[] = [];
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (work: () => Promise<void>) => {
    chain = chain.then(work, work);
    return chain;
  };
  const flushInserts = () => {
    if (pendingInserts.length === 0) return chain;
    const batch = pendingInserts.splice(0);
    return enqueue(async () => {
      const inserted = await ctx.db
        .insert(audioFiles)
        .values(batch.map((f) => ({
          libraryId: root.libraryId, scanRootId: root.id, relPath: f.relPath,
          sizeBytes: f.sizeBytes, mtime: f.mtime, status: 'present',
        })))
        .onConflictDoUpdate({
          target: [audioFiles.scanRootId, audioFiles.relPath],
          set: { status: 'present', lastSeenAt: new Date() },
        })
        .returning({ id: audioFiles.id });
      result.changedIds.push(...inserted.map((r) => r.id));
    });
  };
  const flushChanged = () => {
    if (pendingChanged.length === 0) return chain;
    const batch = pendingChanged.splice(0);
    return enqueue(async () => {
      await ctx.sql`
        update audio_files af
           set size_bytes = c.size_bytes, mtime = c.mtime, status = 'present', last_seen_at = now()
          from unnest(${batch.map((b) => b.id)}::uuid[], ${batch.map((b) => b.sizeBytes)}::bigint[], ${batch.map((b) => b.mtime)}::bigint[])
               as c(id, size_bytes, mtime)
         where af.id = c.id`;
      result.changedIds.push(...batch.map((b) => b.id));
    });
  };
  const flushUnchanged = () => {
    if (pendingUnchanged.length === 0) return chain;
    const batch = pendingUnchanged.splice(0);
    return enqueue(async () => {
      await ctx.sql`update audio_files set last_seen_at = now() where id = any(${batch}::uuid[])`;
    });
  };

  let sinceProgress = 0;
  const progress = async (dir: string) => {
    sinceProgress = 0;
    if (opts.onProgress) await opts.onProgress(result.filesSeen, dir);
  };

  const countFile = (name: string) => {
    result.filesSeen += 1;
    const fmt = extOf(name).slice(1);
    result.formats[fmt] = (result.formats[fmt] ?? 0) + 1;
  };

  const sem = new Semaphore(concurrency);

  const processDir = async (dirAbs: string): Promise<string[]> => {
    const relDir = storagePath(path.relative(root.path, dirAbs));
    let dirMtime: number | null = null;
    try {
      dirMtime = Math.floor((await stat(dirAbs)).mtimeMs / 1000);
    } catch {
      /* mtime unknown: the directory is walked in full */
    }
    let entries;
    try {
      entries = await opendir(dirAbs);
    } catch (err) {
      ctx.logger.warn({ dir: dirAbs, err: (err as Error).message }, 'unreadable directory, skipping');
      result.errored += 1;
      return [];
    }
    result.dirsSeen += 1;
    const subdirs: string[] = [];
    const files: string[] = [];
    for await (const ent of entries) {
      if (ent.isDirectory()) {
        if (!ent.name.startsWith('.')) subdirs.push(path.join(dirAbs, ent.name));
      } else if (ent.isFile()) {
        files.push(ent.name);
      }
    }

    const known = knownDirs.get(relDir);
    if (opts.mode === 'quick' && dirMtime !== null && known !== undefined && known === dirMtime) {
      // Unchanged directory: its index rows stand in for a stat of each file.
      result.dirsSkipped += 1;
      for (const r of byDir.get(relDir) ?? []) {
        if (r.status === 'missing' || r.status === 'archived') continue;
        seen.add(r.relPath);
        countFile(r.relPath);
        pendingUnchanged.push(r.id);
      }
      for (const s of sidecarsByDir.get(relDir) ?? []) {
        seenSidecars.push(s);
        result.sidecars += 1;
      }
    } else {
      for (const name of files) {
        const absPath = path.join(dirAbs, name);
        const relPath = storagePath(path.relative(root.path, absPath));
        if (isAudioFile(name)) {
          let st;
          try {
            st = await stat(absPath);
          } catch (err) {
            ctx.logger.warn({ file: absPath, err: (err as Error).message }, 'stat failed');
            result.errored += 1;
            continue;
          }
          countFile(name);
          seen.add(relPath);
          const prior = byRelPath.get(relPath);
          const mtimeS = Math.floor(st.mtimeMs / 1000);
          if (!prior) {
            result.added += 1;
            pendingInserts.push({ relPath, sizeBytes: st.size, mtime: mtimeS });
          } else if (
            prior.sizeBytes !== st.size || prior.mtime !== mtimeS
            || prior.status === 'missing' || prior.status === 'archived'
            || (opts.reparseErrors === true && prior.status === 'error')
          ) {
            result.changed += 1;
            pendingChanged.push({ id: prior.id, sizeBytes: st.size, mtime: mtimeS });
          } else {
            pendingUnchanged.push(prior.id);
          }
        } else {
          const kind = sidecarKind(name);
          if (kind) {
            try {
              const st = await stat(absPath);
              seenSidecars.push({ relPath, kind, sizeBytes: st.size, mtime: Math.floor(st.mtimeMs / 1000) });
              result.sidecars += 1;
            } catch {
              /* sidecar stat failures are not worth aborting anything */
            }
          }
        }
      }
    }
    if (dirMtime !== null) dirRows.push({ relPath: relDir, mtime: dirMtime });

    if (pendingInserts.length >= INSERT_BATCH) void flushInserts();
    if (pendingChanged.length >= UPDATE_BATCH) void flushChanged();
    if (pendingUnchanged.length >= UPDATE_BATCH) void flushUnchanged();
    sinceProgress += files.length;
    if (sinceProgress >= PROGRESS_EVERY) await progress(relDir);
    return subdirs;
  };

  const walkDir = async (dirAbs: string): Promise<void> => {
    await sem.acquire();
    let subdirs: string[];
    try {
      subdirs = await processDir(dirAbs);
    } finally {
      sem.release();
    }
    await Promise.all(subdirs.map(walkDir));
  };

  const startAbs = await openableDir(root.path, subtree);
  if (startAbs === null) {
    // The folder itself is gone. Everything indexed under it is missing —
    // but only when the root is still there (the caller probed it).
    result.subtreeGone = true;
  } else {
    await walkDir(startAbs);
  }
  await flushInserts();
  await flushChanged();
  await flushUnchanged();
  await chain;

  if (!prefix && result.filesSeen === 0 && existing.length > 0) {
    result.looksUnmounted = true;
    return result;
  }

  // Complete walk: anything indexed in scope but unseen is now missing.
  const unseen = existing.filter((r) => !seen.has(r.relPath) && r.status !== 'missing' && r.status !== 'archived');
  for (let i = 0; i < unseen.length; i += UPDATE_BATCH) {
    const chunk = unseen.slice(i, i + UPDATE_BATCH).map((r) => r.id);
    await ctx.db.update(audioFiles).set({ status: 'missing' }).where(inArray(audioFiles.id, chunk));
  }
  result.missing = unseen.length;
  result.dirsWithMissing = [...new Set(unseen.map((r) => relDirname(r.relPath)))];

  // Sidecars: replace the scope's inventory.
  await ctx.db.delete(sidecarFiles).where(and(eq(sidecarFiles.scanRootId, root.id), sidecarScope));
  for (let i = 0; i < seenSidecars.length; i += INSERT_BATCH) {
    const chunk = seenSidecars.slice(i, i + INSERT_BATCH).map((s) => ({
      libraryId: root.libraryId, scanRootId: root.id, relPath: s.relPath, kind: s.kind,
      sizeBytes: s.sizeBytes, mtime: s.mtime,
    }));
    if (chunk.length > 0) await ctx.db.insert(sidecarFiles).values(chunk);
  }

  // Directory mtimes for the next quick scan; directories that vanished drop out.
  for (let i = 0; i < dirRows.length; i += INSERT_BATCH) {
    const chunk = dirRows.slice(i, i + INSERT_BATCH);
    await ctx.db.insert(scanDirs)
      .values(chunk.map((d) => ({ scanRootId: root.id, relPath: d.relPath, mtime: d.mtime, lastSeenAt: new Date() })))
      .onConflictDoUpdate({
        target: [scanDirs.scanRootId, scanDirs.relPath],
        set: { mtime: dsql`excluded.mtime`, lastSeenAt: new Date() },
      });
  }
  await ctx.db.delete(scanDirs).where(and(
    eq(scanDirs.scanRootId, root.id),
    lt(scanDirs.lastSeenAt, startedAt),
    dirScope,
  ));

  return result;
}

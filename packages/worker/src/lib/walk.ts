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
 *          still catches (and tagave's own tag writes are journaled).
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
import { and, eq, like, lt, or, sql as dsql } from 'drizzle-orm';
import { audioFiles, scanDirs, sidecarFiles } from '@tagave/db';
import type { WorkerContext } from './context.js';
import { isAudioFile, sidecarKind, storagePath, extOf, relDirname } from './helpers.js';
import { finishWalk, type FinishOptions, type FinishResult } from './scanFinish.js';

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

export interface UnseenRow { id: string; relPath: string; sizeBytes: number | null }
export interface WalkTreeResult extends WalkResult {
  walkStart: Date;            // select now() before the walk
  unseen: UnseenRow[];        // present/error rows in scope the walk did not see, minus failed paths
  insertedIds: string[];      // rows this walk created (not conflict-updated)
  failedPaths: string[];      // rel dirs whose opendir failed + rel files whose stat failed
  presentInRoot: number;      // present+error rows of the whole root before the walk
  subtree: string;            // the normalized subtree, '' for a whole root
}

const INSERT_BATCH = 500;
const UPDATE_BATCH = 2000;
const PROGRESS_EVERY = 5000;

const escapeLike = (s: string) => s.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');

/**
 * Directories that never hold music: dot-dirs, NAS housekeeping (Synology
 * `@eaDir` thumbnail trees were 89,458 of the 161,960 directories under the
 * owner's root — every `@eaDir/<file>/SYNOPHOTO_*.jpg` used to be indexed as
 * a sidecar), recycle bins and snapshots.
 */
const SKIP_DIRS = new Set(['@eaDir', '#recycle', '#snapshot', '$RECYCLE.BIN', 'System Volume Information', 'lost+found']);
export function skipDir(name: string): boolean {
  return name.startsWith('.') || SKIP_DIRS.has(name);
}

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

/**
 * The filesystem half of a scan: walks, writes what it saw (last_seen_at by
 * the database's clock, dev:ino on every stat) and reports what it did not
 * see. Nothing is marked missing here; finishWalk does that.
 */
export async function walkTree(ctx: WorkerContext, root: WalkRoot, opts: WalkOptions): Promise<WalkTreeResult> {
  const subtree = storagePath(opts.subtree ?? '').replace(/^\/+|\/+$/g, '');
  const prefix = subtree ? subtree + '/' : '';
  const concurrency = Math.max(1, opts.concurrency ?? 8);
  // The database's clock, never the worker's: every last_seen_at below is now().
  // The shared client returns timestamptz as text; ms truncation only rounds down.
  const [clock] = (await ctx.sql`select now() as now`) as unknown as Array<{ now: string | Date }>;
  const walkStart = new Date(clock!.now);
  const [present] = (await ctx.sql`select count(*)::int as n from audio_files
                                   where scan_root_id = ${root.id} and status in ('present', 'error')`) as unknown as Array<{ n: number }>;

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
  const insertedIds: string[] = [];
  const failedPaths: string[] = [];

  // Batched writes. Arrays are shared by the concurrent directory workers;
  // each flush takes a snapshot and the flushes themselves run in order.
  const pendingInserts: Array<{ relPath: string; sizeBytes: number; mtime: number; inode: string }> = [];
  const pendingChanged: Array<{ id: string; sizeBytes: number; mtime: number; inode: string }> = [];
  const pendingUnchanged: Array<{ id: string; inode: string | null }> = [];
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (work: () => Promise<void>) => {
    chain = chain.then(work, work);
    return chain;
  };
  const flushInserts = () => {
    if (pendingInserts.length === 0) return chain;
    const batch = pendingInserts.splice(0);
    return enqueue(async () => {
      const rows = (await ctx.sql`
        insert into audio_files (library_id, scan_root_id, rel_path, size_bytes, mtime, inode, status)
        select ${root.libraryId}, ${root.id}, u.rel_path, u.size_bytes, u.mtime, u.inode, 'present'
          from unnest(${batch.map((f) => f.relPath)}::text[], ${batch.map((f) => f.sizeBytes)}::bigint[],
                      ${batch.map((f) => f.mtime)}::bigint[], ${batch.map((f) => f.inode)}::text[])
               as u(rel_path, size_bytes, mtime, inode)
        on conflict (scan_root_id, rel_path) do update
          set status = 'present', last_seen_at = now(), inode = coalesce(excluded.inode, audio_files.inode)
        returning id, (xmax = 0) as inserted`) as unknown as Array<{ id: string; inserted: boolean }>;
      result.changedIds.push(...rows.map((r) => r.id));
      insertedIds.push(...rows.filter((r) => r.inserted).map((r) => r.id));
    });
  };
  const flushChanged = () => {
    if (pendingChanged.length === 0) return chain;
    const batch = pendingChanged.splice(0);
    return enqueue(async () => {
      await ctx.sql`
        update audio_files af
           set size_bytes = c.size_bytes, mtime = c.mtime, inode = c.inode, status = 'present', last_seen_at = now()
          from unnest(${batch.map((b) => b.id)}::uuid[], ${batch.map((b) => b.sizeBytes)}::bigint[], ${batch.map((b) => b.mtime)}::bigint[],
                      ${batch.map((b) => b.inode)}::text[])
               as c(id, size_bytes, mtime, inode)
         where af.id = c.id`;
      result.changedIds.push(...batch.map((b) => b.id));
    });
  };
  const flushUnchanged = () => {
    if (pendingUnchanged.length === 0) return chain;
    const batch = pendingUnchanged.splice(0);
    return enqueue(async () => {
      await ctx.sql`
        update audio_files af set last_seen_at = now(), inode = coalesce(c.inode, af.inode)
          from unnest(${batch.map((b) => b.id)}::uuid[], ${batch.map((b) => b.inode)}::text[]) as c(id, inode)
         where af.id = c.id`;
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
      failedPaths.push(relDir);
      return [];
    }
    result.dirsSeen += 1;
    const subdirs: string[] = [];
    const files: string[] = [];
    for await (const ent of entries) {
      if (ent.isDirectory()) {
        if (!skipDir(ent.name)) subdirs.push(path.join(dirAbs, ent.name));
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
        pendingUnchanged.push({ id: r.id, inode: null });
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
            failedPaths.push(relPath);
            continue;
          }
          countFile(name);
          seen.add(relPath);
          const prior = byRelPath.get(relPath);
          const mtimeS = Math.floor(st.mtimeMs / 1000);
          const inode = `${st.dev}:${st.ino}`;
          if (!prior) {
            result.added += 1;
            pendingInserts.push({ relPath, sizeBytes: st.size, mtime: mtimeS, inode });
          } else if (
            prior.sizeBytes !== st.size || prior.mtime !== mtimeS
            || prior.status === 'missing' || prior.status === 'archived'
            || (opts.reparseErrors === true && prior.status === 'error')
          ) {
            result.changed += 1;
            pendingChanged.push({ id: prior.id, sizeBytes: st.size, mtime: mtimeS, inode });
          } else {
            pendingUnchanged.push({ id: prior.id, inode });
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

  // Only files the index expects to find count as evidence of a mount;
  // rows already missing or archived would trip the guard on a root that
  // was legitimately emptied.
  const expected = existing.some((r) => r.status === 'present' || r.status === 'error');
  const tail = { walkStart, insertedIds, failedPaths, presentInRoot: present!.n, subtree };
  if (!prefix && result.filesSeen === 0 && expected) {
    result.looksUnmounted = true;
    return { ...result, ...tail, unseen: [] };
  }

  // Sidecars: upsert what the walk saw (rows keep their ids, so the images
  // that came from them stay valid). Rows in scope it did not see are
  // dropped by finishWalk.
  for (let i = 0; i < seenSidecars.length; i += INSERT_BATCH) {
    const chunk = seenSidecars.slice(i, i + INSERT_BATCH).map((s) => ({
      libraryId: root.libraryId, scanRootId: root.id, relPath: s.relPath, kind: s.kind,
      sizeBytes: s.sizeBytes, mtime: s.mtime, lastSeenAt: dsql`now()`,
    }));
    if (chunk.length > 0) {
      await ctx.db.insert(sidecarFiles).values(chunk).onConflictDoUpdate({
        target: [sidecarFiles.scanRootId, sidecarFiles.relPath],
        set: {
          kind: dsql`excluded.kind`,
          sizeBytes: dsql`excluded.size_bytes`,
          mtime: dsql`excluded.mtime`,
          lastSeenAt: dsql`now()`,
        },
      });
    }
  }
  // Directory mtimes for the next quick scan; directories that vanished drop out.
  for (let i = 0; i < dirRows.length; i += INSERT_BATCH) {
    const chunk = dirRows.slice(i, i + INSERT_BATCH);
    await ctx.db.insert(scanDirs)
      .values(chunk.map((d) => ({ scanRootId: root.id, relPath: d.relPath, mtime: d.mtime, lastSeenAt: dsql`now()` })))
      .onConflictDoUpdate({
        target: [scanDirs.scanRootId, scanDirs.relPath],
        set: { mtime: dsql`excluded.mtime`, lastSeenAt: dsql`now()` },
      });
  }
  await ctx.db.delete(scanDirs).where(and(
    eq(scanDirs.scanRootId, root.id),
    lt(scanDirs.lastSeenAt, walkStart),
    dirScope,
  ));

  const unseen: UnseenRow[] = existing
    .filter((r) => !seen.has(r.relPath) && (r.status === 'present' || r.status === 'error'))
    .map((r) => ({ id: r.id, relPath: r.relPath, sizeBytes: r.sizeBytes }));
  return { ...result, ...tail, unseen };
}

/** walkTree + finishWalk: what scan.root, scan.dir and the tests call. */
export async function walkRoot(ctx: WorkerContext, root: WalkRoot, opts: WalkOptions & FinishOptions): Promise<WalkResult & FinishResult & { walkStart: Date }> {
  const walk = await walkTree(ctx, root, opts);
  const finish = await finishWalk(ctx, root, walk, opts);
  return { ...walk, ...finish };
}

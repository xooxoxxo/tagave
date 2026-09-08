/**
 * The walker against a real temp directory and a real database: full, quick
 * (directory mtimes), subtree, missing detection, the unmounted guard.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, utimes, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { audioFiles, libraries, scanDirs, scanRoots, sidecarFiles, users, makeDb } from '@liner/db';
import pino from 'pino';
import type { WorkerContext } from './context.js';
import { walkRoot } from './walk.js';

/** Directory mtimes have one-second resolution; push them forward explicitly. */
let clock = Math.floor(Date.now() / 1000) + 10;
async function bump(dir: string) {
  clock += 5;
  await utimes(dir, clock, clock);
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('walkRoot', () => {
  let ctx: WorkerContext;
  let db: any;
  let client: any;
  let userId: string;
  let libraryId: string;
  let rootId: string;
  let rootPath: string;
  let root: { id: string; libraryId: string; path: string };

  const rows = async () => db.select().from(audioFiles).where(eq(audioFiles.scanRootId, rootId)) as Promise<Array<{ relPath: string; status: string; sizeBytes: number; mtime: number }>>;
  const byPath = async () => new Map((await rows()).map((r) => [r.relPath, r]));

  beforeAll(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL not set — these suites delete rows and must never run against DATABASE_URL');
    const made = await makeDb(databaseUrl);
    db = made.db;
    client = made.client;
    ctx = { db: made.db, sql: made.client, boss: null as any, logger: pino({ level: 'silent' }) };

    userId = randomUUID();
    await db.insert(users).values({ id: userId, email: `walk-${userId}@test.com`, passwordHash: 'x' });
    libraryId = randomUUID();
    await db.insert(libraries).values({ id: libraryId, name: 'Walk', ownerUserId: userId, settings: {} });

    rootPath = await mkdtemp(path.join(tmpdir(), 'liner-walk-'));
    await mkdir(path.join(rootPath, 'A'));
    await mkdir(path.join(rootPath, 'B', 'CD1'), { recursive: true });
    await writeFile(path.join(rootPath, 'A', '01 - One.mp3'), 'a1');
    await writeFile(path.join(rootPath, 'A', '02 - Two.mp3'), 'a22');
    await writeFile(path.join(rootPath, 'A', 'cover.jpg'), 'img');
    await writeFile(path.join(rootPath, 'B', 'CD1', '01 - Uno.flac'), 'b1');
    await writeFile(path.join(rootPath, 'notes.txt'), 'n');
    for (const d of ['', 'A', 'B', 'B/CD1']) await bump(path.join(rootPath, d));

    rootId = randomUUID();
    await db.insert(scanRoots).values({ id: rootId, libraryId, path: rootPath, displayName: 'walk', validationStatus: 'ok' });
    root = { id: rootId, libraryId, path: rootPath };
  });

  afterAll(async () => {
    await db.delete(scanRoots).where(eq(scanRoots.id, rootId)); // cascades files, sidecars, scan_dirs
    await db.delete(libraries).where(eq(libraries.id, libraryId));
    await db.delete(users).where(eq(users.id, userId));
    await client.end({ timeout: 5 });
    await rm(rootPath, { recursive: true, force: true });
  });

  it('full walk indexes files, sidecars and directory mtimes', async () => {
    const r = await walkRoot(ctx, root, { mode: 'full', concurrency: 3 });
    expect(r.looksUnmounted).toBe(false);
    expect(r).toMatchObject({ filesSeen: 3, added: 3, changed: 0, missing: 0, dirsSeen: 4, dirsSkipped: 0, sidecars: 2 });
    expect(r.formats).toEqual({ mp3: 2, flac: 1 });
    expect(r.changedIds).toHaveLength(3);
    const files = await byPath();
    expect([...files.keys()].sort()).toEqual(['A/01 - One.mp3', 'A/02 - Two.mp3', 'B/CD1/01 - Uno.flac']);
    expect(files.get('A/02 - Two.mp3')?.sizeBytes).toBe(3);
    const sidecars = await db.select().from(sidecarFiles).where(eq(sidecarFiles.scanRootId, rootId));
    expect(sidecars.map((s: any) => `${s.kind}:${s.relPath}`).sort()).toEqual(['image:A/cover.jpg', 'text:notes.txt']);
    const dirs = await db.select().from(scanDirs).where(eq(scanDirs.scanRootId, rootId));
    expect(dirs.map((d: any) => d.relPath).sort()).toEqual(['', 'A', 'B', 'B/CD1']);
  });

  it('a second full walk changes nothing and re-parses nothing', async () => {
    const r = await walkRoot(ctx, root, { mode: 'full' });
    expect(r).toMatchObject({ filesSeen: 3, added: 0, changed: 0, missing: 0 });
    expect(r.changedIds).toHaveLength(0);
  });

  it('quick walk skips every unchanged directory but still counts its files and sidecars', async () => {
    const r = await walkRoot(ctx, root, { mode: 'quick' });
    expect(r).toMatchObject({ filesSeen: 3, added: 0, changed: 0, missing: 0, dirsSeen: 4, dirsSkipped: 4, sidecars: 2 });
    const sidecars = await db.select().from(sidecarFiles).where(eq(sidecarFiles.scanRootId, rootId));
    expect(sidecars).toHaveLength(2);
  });

  it('quick walk enters a directory whose mtime changed and picks up the new file', async () => {
    await writeFile(path.join(rootPath, 'A', '03 - Three.mp3'), 'a333');
    await bump(path.join(rootPath, 'A'));
    const r = await walkRoot(ctx, root, { mode: 'quick' });
    expect(r).toMatchObject({ filesSeen: 4, added: 1, changed: 0, missing: 0, dirsSkipped: 3 });
    expect(r.changedIds).toHaveLength(1);
    expect((await byPath()).get('A/03 - Three.mp3')?.status).toBe('present');
  });

  it('a removed file is marked missing and its directory is reported for re-clustering', async () => {
    await rm(path.join(rootPath, 'B', 'CD1', '01 - Uno.flac'));
    await bump(path.join(rootPath, 'B', 'CD1'));
    const r = await walkRoot(ctx, root, { mode: 'quick' });
    expect(r).toMatchObject({ filesSeen: 3, missing: 1, dirsSkipped: 3 });
    expect(r.dirsWithMissing).toEqual(['B/CD1']);
    expect((await byPath()).get('B/CD1/01 - Uno.flac')?.status).toBe('missing');
  });

  it('a file that comes back is re-indexed and re-parsed', async () => {
    await writeFile(path.join(rootPath, 'B', 'CD1', '01 - Uno.flac'), 'b1');
    await bump(path.join(rootPath, 'B', 'CD1'));
    const r = await walkRoot(ctx, root, { mode: 'quick' });
    expect(r).toMatchObject({ filesSeen: 4, changed: 1, missing: 0 });
    expect((await byPath()).get('B/CD1/01 - Uno.flac')?.status).toBe('present');
  });

  it('reparseErrors re-parses files whose last parse failed even when unchanged', async () => {
    await db.update(audioFiles).set({ status: 'error' }).where(and(eq(audioFiles.scanRootId, rootId), eq(audioFiles.relPath, 'A/01 - One.mp3')));
    const plain = await walkRoot(ctx, root, { mode: 'full' });
    expect(plain.changed).toBe(0);
    expect((await byPath()).get('A/01 - One.mp3')?.status).toBe('error');
    const again = await walkRoot(ctx, root, { mode: 'full', reparseErrors: true });
    expect(again.changed).toBe(1);
    expect((await byPath()).get('A/01 - One.mp3')?.status).toBe('present');
  });

  it('subtree walk confines missing detection to the folder', async () => {
    await rm(path.join(rootPath, 'A', '02 - Two.mp3'));
    await bump(path.join(rootPath, 'A'));
    // pretend B lost a file too — a subtree walk of A must not notice
    const r = await walkRoot(ctx, root, { mode: 'full', subtree: 'A' });
    expect(r).toMatchObject({ filesSeen: 2, missing: 1, dirsSeen: 1 });
    expect(r.dirsWithMissing).toEqual(['A']);
    const files = await byPath();
    expect(files.get('A/02 - Two.mp3')?.status).toBe('missing');
    expect(files.get('B/CD1/01 - Uno.flac')?.status).toBe('present');
    const sidecars = await db.select().from(sidecarFiles).where(eq(sidecarFiles.scanRootId, rootId));
    // only A's sidecar inventory was rebuilt; the root-level text file stays
    expect(sidecars.map((s: any) => s.relPath).sort()).toEqual(['A/cover.jpg', 'notes.txt']);
  });

  it('a deleted folder: subtree walk reports it gone and marks its files missing', async () => {
    await rm(path.join(rootPath, 'B'), { recursive: true });
    await bump(rootPath);
    const r = await walkRoot(ctx, root, { mode: 'full', subtree: 'B/CD1' });
    expect(r.subtreeGone).toBe(true);
    expect(r.missing).toBe(1);
    expect((await byPath()).get('B/CD1/01 - Uno.flac')?.status).toBe('missing');
    const dirs = await db.select().from(scanDirs).where(eq(scanDirs.scanRootId, rootId));
    expect(dirs.map((d: any) => d.relPath)).not.toContain('B/CD1');
  });

  it('a root that suddenly yields nothing is reported unmounted and nothing is marked missing', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'liner-empty-'));
    try {
      const r = await walkRoot(ctx, { ...root, path: empty }, { mode: 'full' });
      expect(r.looksUnmounted).toBe(true);
      expect(r.missing).toBe(0);
      const files = await byPath();
      expect(files.get('A/01 - One.mp3')?.status).toBe('present');
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('sidecar rows keep their ids across walks, and a removed sidecar takes its image row with it', async () => {
    const { images } = await import('@liner/db');
    await writeFile(path.join(rootPath, 'A', 'back.jpg'), 'img2');
    await bump(path.join(rootPath, 'A'));
    await walkRoot(ctx, root, { mode: 'full' });
    const before = await db.select().from(sidecarFiles).where(and(eq(sidecarFiles.scanRootId, rootId), eq(sidecarFiles.relPath, 'A/cover.jpg')));
    expect(before).toHaveLength(1);
    const [albumRow] = await db.select({ id: sidecarFiles.id }).from(sidecarFiles).where(and(eq(sidecarFiles.scanRootId, rootId), eq(sidecarFiles.relPath, 'A/back.jpg')));
    // an image that came from the sidecar (origin = 'sidecar' requires the reference)
    const imageId = randomUUID();
    await db.insert(images).values({
      id: imageId, libraryId, entityType: 'local_album', entityId: randomUUID(), kind: 'front', origin: 'sidecar',
      sidecarFileId: albumRow.id, licenseNote: 'owner file',
    });

    // a walk that sees both sidecars must not touch either row (the old delete+insert broke here)
    await walkRoot(ctx, root, { mode: 'full' });
    const after = await db.select().from(sidecarFiles).where(and(eq(sidecarFiles.scanRootId, rootId), eq(sidecarFiles.relPath, 'A/cover.jpg')));
    expect(after[0].id).toBe(before[0].id);
    expect(await db.select().from(images).where(eq(images.id, imageId))).toHaveLength(1);

    // remove the sidecar the image came from: the image row goes, the walk completes
    await rm(path.join(rootPath, 'A', 'back.jpg'));
    await bump(path.join(rootPath, 'A'));
    const r = await walkRoot(ctx, root, { mode: 'quick' });
    expect(r.sidecars).toBe(2);
    expect(await db.select().from(images).where(eq(images.id, imageId))).toHaveLength(0);
    expect(await db.select().from(sidecarFiles).where(and(eq(sidecarFiles.scanRootId, rootId), eq(sidecarFiles.relPath, 'A/back.jpg')))).toHaveLength(0);
  });

  it('never enters NAS housekeeping directories', async () => {
    await mkdir(path.join(rootPath, 'A', '@eaDir', '01 - One.mp3'), { recursive: true });
    await writeFile(path.join(rootPath, 'A', '@eaDir', '01 - One.mp3', 'SYNOPHOTO_THUMB_XL.jpg'), 'thumb');
    await writeFile(path.join(rootPath, 'A', '@eaDir', 'ghost.mp3'), 'not music');
    await mkdir(path.join(rootPath, '#recycle'), { recursive: true });
    await writeFile(path.join(rootPath, '#recycle', 'deleted.flac'), 'gone');
    await bump(path.join(rootPath, 'A'));
    await bump(rootPath);
    const before = (await rows()).length;
    const r = await walkRoot(ctx, root, { mode: 'full' });
    expect((await rows()).length).toBe(before);
    expect(r.added).toBe(0);
    const sidecars = await db.select().from(sidecarFiles).where(eq(sidecarFiles.scanRootId, rootId));
    expect(sidecars.some((s: any) => s.relPath.includes('@eaDir'))).toBe(false);
    const dirs = await db.select().from(scanDirs).where(eq(scanDirs.scanRootId, rootId));
    expect(dirs.some((d: any) => d.relPath.includes('@eaDir') || d.relPath.startsWith('#recycle'))).toBe(false);
  });

  it('directory mtime is what quick mode trusts', async () => {
    const st = await stat(path.join(rootPath, 'A'));
    const [row] = await db.select().from(scanDirs).where(and(eq(scanDirs.scanRootId, rootId), eq(scanDirs.relPath, 'A')));
    expect(row.mtime).toBe(Math.floor(st.mtimeMs / 1000));
  });
});

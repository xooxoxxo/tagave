/**
 * Tier 1 at the end of a walk: a renamed file or folder keeps its rows (no
 * new audio_files row survives, nothing goes missing), across roots too;
 * a second scan changes nothing; an errored scan matches nothing; two
 * reconciles of one library never interleave. Review focus 1, 3, 4: case- and
 * NFC-only folder renames, top-level ('' dir) files moved into a folder and
 * back, and a second scan right after a merge.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, rename, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { makeDb } from '@tagave/db';
import type { WorkerContext } from './context.js';
import { walkRoot } from './walk.js';
import { withLibraryLock, describeMoves } from './reconcile.js';

describe('describeMoves', () => {
  it('names the biggest folder move and counts the rest', () => {
    expect(describeMoves([
      { fromRootId: 'r', fromDir: 'Artist/Old', toRootId: 'r', toDir: 'Artist/New', files: 214 },
      { fromRootId: 'r', fromDir: 'B', toRootId: 'r', toDir: 'C', files: 3 },
    ])).toBe('moved 217 files: Artist/Old → Artist/New (and 1 more folder)');
    expect(describeMoves([{ fromRootId: 'r', fromDir: '', toRootId: 'r', toDir: 'Loose', files: 1 }])).toBe('moved 1 file: (top folder) → Loose');
    expect(describeMoves([])).toBe('');
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('reconcile Tier 1 (db)', () => {
  let ctx: WorkerContext; let sql: any; let base: string;
  const userId = randomUUID(); const libraryId = randomUUID(); const rootA = randomUUID(); const rootB = randomUUID();
  const A = () => ({ id: rootA, libraryId, path: path.join(base, 'a') });
  const B = () => ({ id: rootB, libraryId, path: path.join(base, 'b') });
  const files = async () => sql`select id, scan_root_id, rel_path, status from audio_files where library_id = ${libraryId} order by rel_path`;
  const idOf = async (relPath: string) => (await sql`select id from audio_files where library_id = ${libraryId} and rel_path = ${relPath}`)[0]?.id;

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    sql = made.client;
    ctx = { db: made.db, sql: made.client, boss: { send: async () => randomUUID() } as any, logger: pino({ level: 'silent' }) };
    await sql`insert into users (id, email, password_hash) values (${userId}, ${`rc-${userId}@test.com`}, 'x')`;
    await sql`insert into libraries (id, name, owner_user_id, settings) values (${libraryId}, 'RC', ${userId}, '{}')`;
    base = await mkdtemp(path.join(tmpdir(), 'tagave-rc-'));
    await mkdir(path.join(base, 'a', 'Artist', 'Old'), { recursive: true });
    await mkdir(path.join(base, 'b'), { recursive: true });
    for (const n of ['1', '2', '3']) await writeFile(path.join(base, 'a', 'Artist', 'Old', `${n}.flac`), `audio-${n}`.repeat(Number(n)));
    await writeFile(path.join(base, 'a', 'top.flac'), 'top-level');
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status) values
              (${rootA}, ${libraryId}, ${path.join(base, 'a')}, 'a', 'ok'), (${rootB}, ${libraryId}, ${path.join(base, 'b')}, 'b', 'ok')`;
    await walkRoot(ctx, A(), { mode: 'full' });
    await walkRoot(ctx, B(), { mode: 'full' });
  });

  afterAll(async () => {
    await sql`delete from scan_roots where library_id = ${libraryId}`;
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
    await rm(base, { recursive: true, force: true });
  });

  it('a renamed file keeps its id', async () => {
    const id = await idOf('Artist/Old/1.flac');
    await rename(path.join(base, 'a', 'Artist', 'Old', '1.flac'), path.join(base, 'a', 'Artist', 'Old', '01 - One.flac'));
    const r = await walkRoot(ctx, A(), { mode: 'full' });
    expect(r).toMatchObject({ merged: 1, missing: 0 });
    expect(await idOf('Artist/Old/01 - One.flac')).toBe(id);
    expect((await files()).length).toBe(4);
  });

  it('a renamed folder keeps every id and reports the move', async () => {
    const before = (await files()).map((f: any) => f.id).sort();
    await rename(path.join(base, 'a', 'Artist', 'Old'), path.join(base, 'a', 'Artist', 'New'));
    const r = await walkRoot(ctx, A(), { mode: 'full' });
    expect(r).toMatchObject({ merged: 3, missing: 0 });
    expect(r.moves).toEqual([{ fromRootId: rootA, fromDir: 'Artist/Old', toRootId: rootA, toDir: 'Artist/New', files: 3 }]);
    expect(r.reclusterDirs).toEqual(expect.arrayContaining([{ scanRootId: rootA, dirPath: 'Artist/Old' }, { scanRootId: rootA, dirPath: 'Artist/New' }]));
    expect((await files()).map((f: any) => f.id).sort()).toEqual(before);
  });

  it('a case-only rename keeps every id', async () => {
    const before = (await files()).map((f: any) => f.id).sort();
    await rename(path.join(base, 'a', 'Artist', 'New'), path.join(base, 'a', 'Artist', 'new-tmp'));
    await rename(path.join(base, 'a', 'Artist', 'new-tmp'), path.join(base, 'a', 'Artist', 'new'));
    const r = await walkRoot(ctx, A(), { mode: 'full' });
    expect(r.merged).toBe(3);
    expect((await files()).map((f: any) => f.id).sort()).toEqual(before);
  });

  it('a top-level file moved into a folder keeps its id', async () => {
    const id = await idOf('top.flac');
    await mkdir(path.join(base, 'a', 'Loose'));
    await rename(path.join(base, 'a', 'top.flac'), path.join(base, 'a', 'Loose', 'top.flac'));
    const r = await walkRoot(ctx, A(), { mode: 'full' });
    expect(r.moves).toEqual([{ fromRootId: rootA, fromDir: '', toRootId: rootA, toDir: 'Loose', files: 1 }]);
    expect(await idOf('Loose/top.flac')).toBe(id);
  });

  it('a file moved from a folder back to the top level keeps its id', async () => {
    const id = await idOf('Loose/top.flac');
    await rename(path.join(base, 'a', 'Loose', 'top.flac'), path.join(base, 'a', 'top.flac'));
    const r = await walkRoot(ctx, A(), { mode: 'full' });
    expect(r).toMatchObject({ merged: 1, missing: 0, added: 0 });
    expect(r.moves).toEqual([{ fromRootId: rootA, fromDir: 'Loose', toRootId: rootA, toDir: '', files: 1 }]);
    expect(r.reclusterDirs).toEqual(expect.arrayContaining([{ scanRootId: rootA, dirPath: 'Loose' }, { scanRootId: rootA, dirPath: '' }]));
    expect(await idOf('top.flac')).toBe(id);
  });

  it('a second scan right after a merge in the same root changes nothing', async () => {
    const before = await files();
    const r = await walkRoot(ctx, A(), { mode: 'full' });
    expect(r).toMatchObject({ merged: 0, missing: 0, added: 0, possibleMoves: 0 });
    expect(await files()).toEqual(before);
  });

  it('an NFC-only folder rename changes no row', async () => {
    const nfc = 'Caf\u00e9';
    await mkdir(path.join(base, 'a', nfc));
    await writeFile(path.join(base, 'a', nfc, 'x.flac'), 'nfc-folder-file');
    await walkRoot(ctx, A(), { mode: 'full' });
    const id = await idOf(`${nfc}/x.flac`);
    expect(id).toBeTruthy();
    await rename(path.join(base, 'a', nfc), path.join(base, 'a', nfc.normalize('NFD')));
    const r = await walkRoot(ctx, A(), { mode: 'full' });
    expect(r).toMatchObject({ merged: 0, missing: 0, added: 0 });
    expect(await idOf(`${nfc}/x.flac`)).toBe(id);
  });

  it('a folder moved to another root (source scanned first) keeps every id', async () => {
    const before = (await files()).map((f: any) => f.id).sort();
    await mkdir(path.join(base, 'b', 'Artist'), { recursive: true });
    await rename(path.join(base, 'a', 'Artist', 'new'), path.join(base, 'b', 'Artist', 'new'));
    const a = await walkRoot(ctx, A(), { mode: 'full' });
    expect(a.missing).toBe(3);                       // nothing to pair with yet
    const b = await walkRoot(ctx, B(), { mode: 'full' });
    expect(b.merged).toBe(3);
    const now = await files();
    expect(now.map((f: any) => f.id).sort()).toEqual(before);
    expect(now.filter((f: any) => f.scan_root_id === rootB).every((f: any) => f.status === 'present')).toBe(true);
  });

  it('a second scan right after merges changes nothing', async () => {
    const before = await files();
    const r = await walkRoot(ctx, B(), { mode: 'full' });
    expect(r).toMatchObject({ merged: 0, missing: 0, added: 0 });
    expect(await files()).toEqual(before);
  });

  it.skipIf(process.getuid?.() === 0)('an errored scan matches nothing and says why', async () => {
    const locked = path.join(base, 'a', 'Locked');
    await mkdir(locked);
    await chmod(locked, 0o000);
    try {
      const id = await idOf('top.flac');
      await rename(path.join(base, 'a', 'top.flac'), path.join(base, 'a', 'top-renamed.flac'));
      const r = await walkRoot(ctx, A(), { mode: 'full' });
      expect(r.merged).toBe(0);
      expect(r.moves).toEqual([]);
      expect(r.reconcileSkipped).toMatch(/could not be read/);
      expect(await idOf('top-renamed.flac')).not.toBe(id);
      expect((await sql`select status from audio_files where id = ${id}`)[0].status).toBe('missing');
    } finally {
      await chmod(locked, 0o755);
    }
  });

  it('two reconciles of one library run one after the other', async () => {
    const order: string[] = [];
    await Promise.all([
      withLibraryLock(ctx, libraryId, async () => { order.push('a1'); await new Promise((r) => setTimeout(r, 200)); order.push('a2'); }),
      (async () => { await new Promise((r) => setTimeout(r, 20)); await withLibraryLock(ctx, libraryId, async () => { order.push('b'); }); })(),
    ]);
    expect(order).toEqual(['a1', 'a2', 'b']);
  });
});

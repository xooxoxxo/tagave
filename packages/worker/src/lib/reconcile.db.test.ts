/**
 * Tier 1 at the end of a walk: a renamed file or folder keeps its rows (no
 * new audio_files row survives, nothing goes missing), across roots too;
 * a second scan changes nothing; an errored scan matches nothing; two
 * reconciles of one library never interleave. Review focus 1, 3, 4: case- and
 * NFC-only folder renames, top-level ('' dir) files moved into a folder and
 * back, and a second scan right after a merge.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, rename, chmod, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { makeDb } from '@tagave/db';
import type { WorkerContext } from './context.js';
import { walkRoot, walkTree } from './walk.js';
import { withLibraryLock, describeMoves, rowsInDirs, sqlDirname } from './reconcile.js';
import { finishNotes, finishWalk } from './scanFinish.js';
import { scanDirMessage } from '../jobs/scanDir.js';

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

/**
 * Spec §1, destination scanned and clustered first: the copy on root B has an
 * album before root A's walk notices the source gone. Untouched, it is merged
 * into the old rows (old ids win); with owner data on it, it is left alone and
 * counted as a possible move.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)('reconcile Tier 1, destination clustered first (db)', () => {
  let ctx: WorkerContext; let sql: any; let base: string;
  const userId = randomUUID(); const libraryId = randomUUID(); const rootA = randomUUID(); const rootB = randomUUID();
  const A = () => ({ id: rootA, libraryId, path: path.join(base, 'a') });
  const B = () => ({ id: rootB, libraryId, path: path.join(base, 'b') });
  const rowsIn = async (root: string, dir: string) =>
    (await sql`select id from audio_files where scan_root_id = ${root} and rel_path like ${`${dir}/%`} order by rel_path`).map((r: any) => r.id as string);
  /** cluster.dir's result, by hand: one album over the given rows */
  const album = async (fileIds: string[], state = 'pending') => {
    const id = randomUUID();
    await sql`insert into local_albums (id, library_id, cluster_key, state) values (${id}, ${libraryId}, ${`k:${id}`}, ${state})`;
    for (const f of fileIds) await sql`insert into local_tracks (local_album_id, audio_file_id) values (${id}, ${f})`;
    return id;
  };
  const albumCount = async () => (await sql`select count(*)::int as n from local_albums where library_id = ${libraryId}`)[0].n as number;
  /** Album `name` (3 files) on root A, scanned and clustered; one more file keeps root A from looking unmounted. */
  const seed = async (name: string) => {
    await mkdir(path.join(base, 'a', name), { recursive: true });
    for (const n of ['1', '2', '3']) await writeFile(path.join(base, 'a', name, `${n}.flac`), `${name}-${n}`.repeat(Number(n) + 1));
    await walkRoot(ctx, A(), { mode: 'full' });
    const oldIds = await rowsIn(rootA, name);
    return { oldIds, oldAlbum: await album(oldIds, 'matched') };
  };
  /** Moves `name` to root B, scans B and clusters the copy there (the source is not rescanned yet). */
  const moveAndClusterB = async (name: string) => {
    await rename(path.join(base, 'a', name), path.join(base, 'b', name));
    await walkRoot(ctx, B(), { mode: 'full' });
    return album(await rowsIn(rootB, name));
  };

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    sql = made.client;
    ctx = { db: made.db, sql: made.client, boss: { send: async () => randomUUID() } as any, logger: pino({ level: 'silent' }) };
    await sql`insert into users (id, email, password_hash) values (${userId}, ${`rcd-${userId}@test.com`}, 'x')`;
    await sql`insert into libraries (id, name, owner_user_id, settings) values (${libraryId}, 'RCD', ${userId}, '{}')`;
    base = await mkdtemp(path.join(tmpdir(), 'tagave-rcd-'));
    await mkdir(path.join(base, 'a', 'Keep'), { recursive: true });
    await mkdir(path.join(base, 'b'), { recursive: true });
    for (const n of ['1', '2', '3', '4']) await writeFile(path.join(base, 'a', 'Keep', `${n}.flac`), `keep-${n}`.repeat(Number(n) + 7));
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status) values
              (${rootA}, ${libraryId}, ${path.join(base, 'a')}, 'a', 'ok'), (${rootB}, ${libraryId}, ${path.join(base, 'b')}, 'b', 'ok')`;
  });

  afterAll(async () => {
    await sql`delete from local_albums where library_id = ${libraryId}`;
    await sql`delete from scan_roots where library_id = ${libraryId}`;
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
    await rm(base, { recursive: true, force: true });
  });

  it('untouched: the copy is absorbed, the old rows and album take its place, no album is added', async () => {
    const { oldIds, oldAlbum } = await seed('One');
    const freshAlbum = await moveAndClusterB('One');
    const albums = await albumCount();
    const r = await walkRoot(ctx, A(), { mode: 'full' });
    expect(r).toMatchObject({ merged: 3, missing: 0, possibleMoves: 0 });
    expect(await rowsIn(rootB, 'One')).toEqual(oldIds);
    expect(await sql`select distinct local_album_id from local_tracks where audio_file_id = any(${oldIds}::uuid[])`).toEqual([{ local_album_id: oldAlbum }]);
    expect(await sql`select 1 from local_albums where id = ${freshAlbum}`).toHaveLength(0);
    expect(await albumCount()).toBe(albums - 1);
  });

  it('the owner locked the copy\'s album: nothing merges, the pairs are possible moves', async () => {
    const { oldIds } = await seed('Two');
    const freshAlbum = await moveAndClusterB('Two');
    await sql`insert into field_locks (library_id, scope, scope_id, field, created_by) values (${libraryId}, 'album', ${freshAlbum}, 'year', ${userId})`;
    const freshIds = await rowsIn(rootB, 'Two');
    const r = await walkRoot(ctx, A(), { mode: 'full' });
    expect(r).toMatchObject({ merged: 0, missing: 3, possibleMoves: 3 });
    expect(await rowsIn(rootB, 'Two')).toEqual(freshIds);
    expect(await sql`select count(*)::int as n from audio_files where id = any(${oldIds}::uuid[]) and status = 'missing'`).toEqual([{ n: 3 }]);
    expect(await sql`select 1 from local_albums where id = ${freshAlbum}`).toHaveLength(1);
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

  it.skipIf(process.getuid?.() === 0)('a scan with an unreadable folder still matches moves, and pairs nothing under that folder', async () => {
    const locked = path.join(base, 'a', 'Locked');
    await mkdir(locked);
    await writeFile(path.join(locked, 'l.flac'), 'locked-file');
    await walkRoot(ctx, A(), { mode: 'full' });
    const lockedId = await idOf('Locked/l.flac');
    const st = await stat(path.join(locked, 'l.flac'));
    await chmod(locked, 0o000);
    try {
      // same name, size and mtime elsewhere: would pair if the locked row counted as vanished
      await mkdir(path.join(base, 'a', 'Other'));
      await writeFile(path.join(base, 'a', 'Other', 'l.flac'), 'locked-file');
      await utimes(path.join(base, 'a', 'Other', 'l.flac'), st.atime, st.mtime);
      const id = await idOf('top.flac');
      await rename(path.join(base, 'a', 'top.flac'), path.join(base, 'a', 'top-renamed.flac'));
      const r = await walkRoot(ctx, A(), { mode: 'full' });
      expect(r).toMatchObject({ merged: 1, missing: 0, added: 1, failedDirs: ['Locked'], reconcileSkipped: null });
      expect(await idOf('top-renamed.flac')).toBe(id);
      expect((await sql`select status from audio_files where id = ${lockedId}`)[0].status).toBe('present');
      expect(await idOf('Other/l.flac')).not.toBe(lockedId);
      expect(finishNotes(r)).toMatch(/could not read Locked/);
      expect(finishNotes(r)).not.toMatch(/not matched/);
    } finally {
      await chmod(locked, 0o755);
    }
  });

  it('a folder whose files moved elsewhere, rescanned on its own, says where they went', async () => {
    await mkdir(path.join(base, 'a', 'Gone'));
    await writeFile(path.join(base, 'a', 'Gone', 'g.flac'), 'gone-folder-file');
    await walkRoot(ctx, A(), { mode: 'full' });
    const id = await idOf('Gone/g.flac');
    await rename(path.join(base, 'a', 'Gone'), path.join(base, 'a', 'Here'));
    await walkRoot(ctx, A(), { mode: 'full', subtree: 'Here' });     // destination first: a new row
    const r = await walkRoot(ctx, A(), { mode: 'full', subtree: 'Gone' });
    expect(r).toMatchObject({ subtreeGone: true, merged: 1, missing: 0 });
    expect(scanDirMessage(r, 0)).toBe('folder moved: 1 file(s) now at Here');
    expect(await idOf('Here/g.flac')).toBe(id);
  });

  it('a fresh-folder row on a failed path still counts as an edition extra (never pairs)', async () => {
    await mkdir(path.join(base, 'a', 'Ed', 'Std'), { recursive: true });
    await writeFile(path.join(base, 'a', 'Ed', 'Std', 's1.flac'), 'standard-edition-one-xx');
    await writeFile(path.join(base, 'a', 'Ed', 'Std', 's2.flac'), 'standard-edition-two-xxxx');
    await walkRoot(ctx, A(), { mode: 'full' });
    const olds = [await idOf('Ed/Std/s1.flac'), await idOf('Ed/Std/s2.flac')];
    // a row in the destination, first seen after the standard files: the walk below cannot stat it
    await sql`insert into audio_files (library_id, scan_root_id, rel_path, size_bytes, mtime, status)
              values (${libraryId}, ${rootA}, 'Ed/Deluxe/bonus.flac', 424242, 1, 'present')`;
    const bonus = await idOf('Ed/Deluxe/bonus.flac');
    await rename(path.join(base, 'a', 'Ed', 'Std'), path.join(base, 'a', 'Ed', 'Deluxe'));
    const w = await walkTree(ctx, A(), { mode: 'full' });
    w.failedPaths.push('Ed/Deluxe/bonus.flac');                   // as a stat failure would
    const f = await finishWalk(ctx, A(), w);
    expect(f.merged).toBe(0);
    expect(f.possibleMoves).toBeGreaterThan(0);
    expect(await idOf('Ed/Deluxe/s1.flac')).not.toBe(olds[0]);
    expect((await sql`select status from audio_files where id = ${bonus}`)[0].status).toBe('present');
  });

  it('the lock is released and its connection returned when fn throws', async () => {
    for (let i = 0; i < 15; i++) {        // more than the pool's 10 connections
      await expect(withLibraryLock(ctx, libraryId, async () => { throw new Error(`boom ${i}`); })).rejects.toThrow(`boom ${i}`);
    }
    const key = `files.reconcile:${libraryId}`;
    const other = await makeDb(process.env.TEST_DATABASE_URL!);
    try {
      expect((await other.client`select pg_try_advisory_lock(hashtextextended(${key}, 0)) as got`)[0]?.["got"]).toBe(true);
      await other.client`select pg_advisory_unlock(hashtextextended(${key}, 0))`;
    } finally {
      await other.client.end({ timeout: 5 });
    }
  });

  it('the indexed folder lookup returns exactly the rows sqlDirname groups into those folders', async () => {
    const rootC = randomUUID();
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status) values (${rootC}, ${libraryId}, ${path.join(base, 'c')}, 'c', 'ok')`;
    const paths = ['X/a.flac', 'X/Y/b.flac', 'X0/c.flac', 'X-/d.flac', 'X /e.flac', 'Xa/f.flac', 'x/g.flac', 'top.flac', '\u00c9/h.flac', 'X/Y/Z/i.flac', 'X%/j.flac', 'X_/k.flac'];
    for (const p of paths) await sql`insert into audio_files (library_id, scan_root_id, rel_path, status) values (${libraryId}, ${rootC}, ${p}, 'missing')`;
    const dirs = ['X', 'X/Y', '', '\u00c9', 'X%', 'Nope'].map((dirPath) => ({ scanRootId: rootC, dirPath }));
    const got = (await rowsInDirs(ctx, libraryId, dirs, sql`true`)).map((f) => f.relPath).sort();
    const want = (await sql`select rel_path from audio_files af where af.scan_root_id = ${rootC}
                              and ${sql.unsafe(sqlDirname('af'))} = any(${dirs.map((d) => d.dirPath)}::text[])`).map((r: any) => r.rel_path).sort();
    expect(got).toEqual(want);
    expect(got).toEqual(['X%/j.flac', 'X/Y/b.flac', 'X/a.flac', 'top.flac', '\u00c9/h.flac'].sort());
    await sql`delete from scan_roots where id = ${rootC}`;
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

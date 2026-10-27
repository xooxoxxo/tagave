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
import { scanRootJob } from '../jobs/scanRoot.js';
import { writeFlac } from '../testkit/flac.js';
import { drainJobs, type Sent } from '../testkit/moveLab.js';

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
 * Spec §1, destination scanned and clustered first, end to end: real FLAC
 * files, real scan.root, and the scan.parse / cluster.dir jobs it queues run
 * by the acceptance kit's pump (testkit/moveLab drainJobs), follow-up
 * re-clusters included. The copy on root B gets an album before root A's
 * scan notices the source gone. Untouched, it is folded into the old album
 * (old ids win, nothing is added); with owner data on any of its files, the
 * whole album is left alone and the old album keeps everything.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)('reconcile Tier 1, destination clustered first (db)', () => {
  let ctx: WorkerContext; let sql: any; let base: string;
  const queue: Sent[] = [];
  const userId = randomUUID(); const libraryId = randomUUID(); const rootA = randomUUID(); const rootB = randomUUID();
  let pad = 8;

  const drain = () => drainJobs(ctx, queue);
  const scan = async (root: string) => { const r = await scanRootJob(ctx, { scanRootId: root, mode: 'full' }); await drain(); return r; };
  const albumCount = async () => (await sql`select count(*)::int as n from local_albums where library_id = ${libraryId}`)[0].n as number;
  const filesIn = async (root: string, dir: string) =>
    (await sql`select id::text as id from audio_files where scan_root_id = ${root} and rel_path like ${`${dir}/%`} order by rel_path`).map((r: any) => r.id as string);
  const albumsOf = async (fileIds: string[]) =>
    (await sql`select distinct local_album_id::text as id from local_tracks where audio_file_id = any(${fileIds}::uuid[])`).map((r: any) => r.id as string);
  const lastRun = async () => (await sql`select progress from job_runs where library_id = ${libraryId} and type = 'scan.root' order by created_at desc limit 1`)[0]?.progress;
  /** an album of 3 files in root A's `dir`, scanned and clustered, with owner history on it */
  const seed = async (dir: string, album: string) => {
    await mkdir(path.join(base, 'a', dir), { recursive: true });
    for (let t = 1; t <= 3; t++) {
      pad += 7; // every file a different size
      await writeFlac(path.join(base, 'a', dir, `${t}.flac`), { title: `${album} ${t}`, artist: 'Artist', albumartist: 'Artist', album, track: t, seconds: 30 + t, padding: pad });
    }
    await scan(rootA);
    const oldIds = await filesIn(rootA, dir);
    const [oldAlbum] = await albumsOf(oldIds);
    expect(oldAlbum).toBeTruthy();
    const [rg] = await sql`insert into release_groups (mbid, title) values (${randomUUID()}, ${album}) returning id`;
    const [rel] = await sql`insert into releases (release_group_id, mbid, title) values (${rg.id}, ${randomUUID()}, ${album}) returning id`;
    await sql`update local_albums set state = 'matched', release_id = ${rel.id}, release_group_id = ${rg.id} where id = ${oldAlbum}`;
    await sql`insert into album_matches (library_id, local_album_id, release_id, distance, status, decided_by) values (${libraryId}, ${oldAlbum}, ${rel.id}, 0.05, 'confirmed', 'user')`;
    await sql`insert into field_locks (library_id, scope, scope_id, field, value, created_by) values (${libraryId}, 'album', ${oldAlbum}, 'year', '2001'::jsonb, ${userId})`;
    const [listen] = await sql`insert into player_listens (user_id, library_id, local_album_id, started_at, ended_at, tracks_heard, tracks_total)
                               values (${userId}, ${libraryId}, ${oldAlbum}, now() - interval '1 day', now() - interval '23 hours', 3, 3) returning id`;
    return { oldIds, oldAlbum: oldAlbum!, listen: listen.id as string, rgId: rg.id as string };
  };
  /** Ao keeps its match, lock and listen */
  const expectHistory = async (s: Awaited<ReturnType<typeof seed>>) => {
    expect(await sql`select status, decided_by from album_matches where local_album_id = ${s.oldAlbum}`).toEqual([{ status: 'confirmed', decided_by: 'user' }]);
    expect(await sql`select field from field_locks where scope = 'album' and scope_id = ${s.oldAlbum}`).toEqual([{ field: 'year' }]);
    expect(await sql`select local_album_id::text as a from player_listens where id = ${s.listen}`).toEqual([{ a: s.oldAlbum }]);
    expect((await sql`select state from local_albums where id = ${s.oldAlbum}`)[0].state).toBe('matched');
  };
  const rgIds: string[] = [];

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    sql = made.client;
    ctx = { db: made.db, sql: made.client, logger: pino({ level: 'silent' }),
            boss: { send: async (name: string, data: any) => { queue.push({ name, data }); return randomUUID(); } } as any };
    await sql`insert into users (id, email, password_hash) values (${userId}, ${`rcd-${userId}@test.com`}, 'x')`;
    await sql`insert into libraries (id, name, owner_user_id, settings) values (${libraryId}, 'RCD', ${userId}, '{}')`;
    base = await mkdtemp(path.join(tmpdir(), 'tagave-rcd-'));
    await mkdir(path.join(base, 'a', 'Keep', 'Other'), { recursive: true });
    await mkdir(path.join(base, 'b'), { recursive: true });
    // root A must not look unmounted when an album leaves it
    for (let t = 1; t <= 2; t++) await writeFlac(path.join(base, 'a', 'Keep', 'Other', `${t}.flac`), { title: `K${t}`, artist: 'Keeper', album: 'Other', track: t, padding: 3 + t });
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status) values
              (${rootA}, ${libraryId}, ${path.join(base, 'a')}, 'a', 'ok'), (${rootB}, ${libraryId}, ${path.join(base, 'b')}, 'b', 'ok')`;
  });

  afterAll(async () => {
    await sql`delete from local_albums where library_id = ${libraryId}`;
    await sql`delete from scan_roots where library_id = ${libraryId}`;
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from users where id = ${userId}`;
    const rgs = (await sql`select id from release_groups where id = any(${rgIds}::uuid[])`).map((r: any) => r.id);
    await sql`delete from releases where release_group_id = any(${rgs}::uuid[])`;
    await sql`delete from release_groups where id = any(${rgs}::uuid[])`;
    await sql.end({ timeout: 5 });
    await rm(base, { recursive: true, force: true });
  });

  it('untouched copy in another folder: absorbed into the old album; listens and links on the copy move; nothing is added', async () => {
    const s = await seed('Artist/Album One', 'Album One'); rgIds.push(s.rgId);
    const albums = await albumCount();
    await mkdir(path.join(base, 'b', 'Moved'), { recursive: true });
    await rename(path.join(base, 'a', 'Artist', 'Album One'), path.join(base, 'b', 'Moved', 'Album One'));
    await scan(rootB);                                                     // the copy gets its own pending album
    const freshIds = await filesIn(rootB, 'Moved/Album One');
    const [freshAlbum] = await albumsOf(freshIds);
    expect(freshAlbum).not.toBe(s.oldAlbum);
    expect(await albumCount()).toBe(albums + 1);
    const [copyListen] = await sql`insert into player_listens (user_id, library_id, local_album_id, started_at, ended_at, tracks_heard, tracks_total)
                                   values (${userId}, ${libraryId}, ${freshAlbum}, now() - interval '1 hour', now(), 1, 3) returning id`;
    const [source] = await sql`insert into collection_sources (library_id, provider) values (${libraryId}, 'discogs') returning id`;
    const [item] = await sql`insert into collection_items (library_id, collection_source_id, provider_item_id, local_album_id)
                             values (${libraryId}, ${source.id}, 'one', ${freshAlbum}) returning id`;

    await scan(rootA);                                                     // the source is gone: Repair-style merge, then re-clusters
    expect((await lastRun()).message).toMatch(/ 0 missing, moved 3 files: Artist\/Album One → Moved\/Album One/);

    expect(await filesIn(rootB, 'Moved/Album One')).toEqual(s.oldIds);
    expect(await albumsOf(s.oldIds)).toEqual([s.oldAlbum]);
    expect(await sql`select count(*)::int as n from local_tracks where local_album_id = ${s.oldAlbum}`).toEqual([{ n: 3 }]);
    expect(await sql`select 1 from local_albums where id = ${freshAlbum}`).toHaveLength(0);
    expect(await albumCount()).toBe(albums);
    await expectHistory(s);
    expect(await sql`select local_album_id::text as a from player_listens where id = ${copyListen.id}`).toEqual([{ a: s.oldAlbum }]);
    expect(await sql`select local_album_id::text as a from collection_items where id = ${item.id}`).toEqual([{ a: s.oldAlbum }]);
    expect((await sql`select dir_paths from local_albums where id = ${s.oldAlbum}`)[0].dir_paths).toEqual(['Moved/Album One']);
    // a later scan of either root changes nothing
    await scan(rootB); await scan(rootA);
    expect(await albumsOf(s.oldIds)).toEqual([s.oldAlbum]);
    expect(await albumCount()).toBe(albums);
  });

  it('owner data on one file of the copy: none of its pairs merge, and the re-clusters leave the old album whole', async () => {
    const s = await seed('Artist/Album Three', 'Album Three'); rgIds.push(s.rgId);
    await mkdir(path.join(base, 'b', 'Moved'), { recursive: true });
    await rename(path.join(base, 'a', 'Artist', 'Album Three'), path.join(base, 'b', 'Moved', 'Album Three'));
    await scan(rootB);
    const freshIds = await filesIn(rootB, 'Moved/Album Three');
    const [freshAlbum] = await albumsOf(freshIds);
    await sql`insert into field_locks (library_id, scope, scope_id, field, created_by) values (${libraryId}, 'track', ${freshIds[2]}, 'title', ${userId})`;
    const albums = await albumCount();

    await scan(rootA);

    expect((await lastRun()).message).toMatch(/ 3 missing, 3 possible move\(s\) left alone/);
    expect(await sql`select count(*)::int as n from audio_files where id = any(${s.oldIds}::uuid[]) and status = 'missing'`).toEqual([{ n: 3 }]);
    expect(await albumsOf(s.oldIds)).toEqual([s.oldAlbum]);              // all three old tracks stay on the old album
    expect(await sql`select count(*)::int as n from local_tracks where local_album_id = ${s.oldAlbum}`).toEqual([{ n: 3 }]);
    expect(await albumsOf(freshIds)).toEqual([freshAlbum]);
    await expectHistory(s);
    expect(await albumCount()).toBe(albums);
  });

  it('same path on another root: the copy was clustered onto the old album itself, owner-confirmed; it merges and nothing is added', async () => {
    const s = await seed('Artist/Album Two', 'Album Two'); rgIds.push(s.rgId);
    const albums = await albumCount();
    await mkdir(path.join(base, 'b', 'Artist'), { recursive: true });
    await rename(path.join(base, 'a', 'Artist', 'Album Two'), path.join(base, 'b', 'Artist', 'Album Two'));
    await scan(rootB);
    const freshIds = await filesIn(rootB, 'Artist/Album Two');
    expect(await albumsOf(freshIds)).toEqual([s.oldAlbum]);              // same cluster key: no album of its own
    expect(await albumCount()).toBe(albums);

    await scan(rootA);

    expect((await lastRun()).message).toMatch(/ 0 missing, moved 3 files: Artist\/Album Two → Artist\/Album Two/);
    expect(await filesIn(rootB, 'Artist/Album Two')).toEqual(s.oldIds);
    expect(await sql`select audio_file_id::text as f from local_tracks where local_album_id = ${s.oldAlbum} order by 1`)
      .toEqual([...s.oldIds].sort().map((f) => ({ f })));
    expect(await sql`select 1 from audio_files where id = any(${freshIds}::uuid[])`).toHaveLength(0);
    await expectHistory(s);
    expect(await albumCount()).toBe(albums);
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

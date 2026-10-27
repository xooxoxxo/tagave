/**
 * A moved album keeps its id through carry-over even when one of its tracks
 * was already missing before the move: only live files (present or error)
 * count towards "every file of the album is in the new folder".
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { makeDb } from '@tagave/db';
import type { WorkerContext } from '../lib/context.js';
import { writeFlac } from '../testkit/flac.js';
import { albumKeyLock, clusterDirJob, retireEmptyAlbums } from './clusterDir.js';
import { scanParseJob } from './scanParse.js';
import { scanRootJob } from './scanRoot.js';
import { scanDirJob } from './scanDir.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('carry-over with a missing track (db)', () => {
  let ctx: WorkerContext; let sql: any;
  const userId = randomUUID(); const libraryId = randomUUID(); const rootId = randomUUID();
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const tags = (n: number) => ({ common: { album: 'Album One', albumartist: 'Artist', artist: 'Artist', title: `S${n}`, track: { no: n } } });
  const albumOf = async (id: string) => (await sql`select local_album_id from local_tracks where audio_file_id = ${id}`)[0]?.local_album_id;

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    sql = made.client;
    ctx = { db: made.db, sql: made.client, boss: { send: async () => randomUUID() } as any, logger: pino({ level: 'silent' }) };
    await sql`insert into users (id, email, password_hash) values (${userId}, ${`co-${userId}@test.com`}, 'x')`;
    await sql`insert into libraries (id, name, owner_user_id, settings) values (${libraryId}, 'CO', ${userId}, '{}')`;
    await sql`insert into scan_roots (id, library_id, path, display_name) values (${rootId}, ${libraryId}, '/nonexistent-co', 'co')`;
    for (const [i, id] of ids.entries()) {
      await sql`insert into audio_files (id, library_id, scan_root_id, rel_path, status, duration_ms, tags_raw)
                values (${id}, ${libraryId}, ${rootId}, ${`Artist/Old/${i + 1}.flac`}, 'present', 1000, ${JSON.stringify(tags(i + 1))}::text::jsonb)`;
    }
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: 'Artist/Old' });
    await sql`update local_albums set state = 'matched' where library_id = ${libraryId}`;
  });

  afterAll(async () => {
    await sql`delete from local_albums where library_id = ${libraryId}`;
    await sql`delete from scan_roots where id = ${rootId}`;
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
  });

  it('the album keeps its id, state and the missing track row', async () => {
    const albumId = await albumOf(ids[0]!);
    await sql`update audio_files set status = 'missing' where id = ${ids[3]}`;
    // what a Tier 1 merge leaves behind: the three live rows now live in Artist/New
    for (const [i, id] of ids.slice(0, 3).entries()) {
      await sql`update audio_files set rel_path = ${`Artist/New/${i + 1}.flac`} where id = ${id}`;
    }
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: 'Artist/New' });
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: 'Artist/Old' });
    for (const id of ids) expect(await albumOf(id)).toBe(albumId);
    const [a] = await sql`select state, dir_paths from local_albums where id = ${albumId}`;
    expect(a.state).toBe('matched');
    expect(a.dir_paths).toEqual(['Artist/New']);
    expect((await sql`select count(*)::int as n from local_albums where library_id = ${libraryId}`)[0].n).toBe(1);
  });
});

/**
 * Spec acceptance (Task 12): after a rescan, a moved album keeps its id, its
 * match and its album locks, and local_albums does not grow. Real FLAC files,
 * real scan.root; the queued scan.parse and cluster.dir jobs are run by a
 * small pump (one per singletonKey per round, cluster.dir jobs of one round
 * concurrently, as pg-boss workers would run them).
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)('moves keep their album (db)', () => {
  let ctx: WorkerContext; let sql: any; let pathA: string; let pathB: string;
  const queue: Array<{ name: string; data: any; opts: any }> = [];
  const userId = randomUUID(); const libraryId = randomUUID(); const rootA = randomUUID(); const rootB = randomUUID();
  /** album title -> file names, in folders under root A */
  const layout: Array<{ dir: string; album: string; artist: string; n: number }> = [
    { dir: 'Solo/Album One', album: 'Album One', artist: 'Solo', n: 3 },
    { dir: 'Band/First', album: 'First', artist: 'Band', n: 2 },
    { dir: 'Band/Second', album: 'Second', artist: 'Band', n: 2 },
    { dir: 'Band/Third', album: 'Third', artist: 'Band', n: 2 },
    { dir: 'Box/Set CD1', album: 'Set', artist: 'Boxer', n: 2 },
    { dir: 'Box/Set CD2', album: 'Set', artist: 'Boxer', n: 2 },
    { dir: 'Travel/Away', album: 'Away', artist: 'Traveller', n: 2 },
  ];
  const before = new Map<string, { id: string; fileIds: string[] }>();
  let albumCount = 0;

  const drain = async () => {
    for (let round = 0; round < 10 && queue.length > 0; round++) {
      const batch = queue.splice(0);
      for (const j of batch) if (j.name === 'scan.parse') await scanParseJob(ctx, j.data);
      const once = new Map<string, any>();
      for (const j of batch) if (j.name === 'cluster.dir') once.set(`${j.data.scanRootId}\n${j.data.dirPath}`, j.data);
      await Promise.all([...once.values()].map((d) => clusterDirJob(ctx, d)));
    }
    expect(queue.filter((j) => j.name === 'scan.parse' || j.name === 'cluster.dir')).toEqual([]);
  };
  const albumCountNow = async () => (await sql`select count(*)::int as n from local_albums where library_id = ${libraryId}`)[0].n as number;
  const albumOfFiles = async (fileIds: string[]) =>
    (await sql`select distinct local_album_id::text as id from local_tracks where audio_file_id = any(${fileIds}::uuid[])`).map((r: any) => r.id);
  /** id, match and album lock unchanged; the album lists the new folders */
  const expectKept = async (album: string, dirPaths: string[]) => {
    const b = before.get(album)!;
    expect(await albumOfFiles(b.fileIds)).toEqual([b.id]);
    const [a] = await sql`select state, dir_paths from local_albums where id = ${b.id}`;
    expect(a).toEqual({ state: 'matched', dir_paths: dirPaths });
    const locks = await sql`select field from field_locks where scope = 'album' and scope_id = ${b.id}`;
    expect(locks.map((l: any) => l.field)).toEqual(['title']);
    const files = await sql`select id::text as id, status from audio_files where id = any(${b.fileIds}::uuid[])`;
    expect(files.length).toBe(b.fileIds.length);
    expect(files.every((f: any) => f.status === 'present')).toBe(true);
  };

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    sql = made.client;
    ctx = {
      db: made.db, sql: made.client, logger: pino({ level: 'silent' }),
      boss: { send: async (name: string, data: any, opts: any) => { queue.push({ name, data, opts }); return randomUUID(); } } as any,
    };
    pathA = await mkdtemp(path.join(tmpdir(), 'tagave-co-a-'));
    pathB = await mkdtemp(path.join(tmpdir(), 'tagave-co-b-'));
    let pad = 8;
    for (const l of layout) {
      await mkdir(path.join(pathA, l.dir), { recursive: true });
      const disc = l.dir.endsWith('CD2') ? 2 : l.dir.endsWith('CD1') ? 1 : undefined;
      for (let t = 1; t <= l.n; t++) {
        pad += 7; // every file a different size: Tier 1 pairs by size first
        await writeFlac(path.join(pathA, l.dir, `${t}.flac`),
          { title: `${l.album} ${disc ?? ''}${t}`, artist: l.artist, albumartist: l.artist, album: l.album, track: t, ...(disc ? { disc } : {}), seconds: 30 + t, padding: pad });
      }
    }
    await sql`insert into users (id, email, password_hash) values (${userId}, ${`com-${userId}@test.com`}, 'x')`;
    await sql`insert into libraries (id, name, owner_user_id, settings) values (${libraryId}, 'COM', ${userId}, '{}')`;
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status) values
      (${rootA}, ${libraryId}, ${pathA}, 'com-a', 'ok'), (${rootB}, ${libraryId}, ${pathB}, 'com-b', 'ok')`;
    await scanRootJob(ctx, { scanRootId: rootA, mode: 'full' });
    await drain();
    const rows = await sql`
      select la.id::text as id, la.title_guess as title, array_agg(lt.audio_file_id::text) as files
        from local_albums la join local_tracks lt on lt.local_album_id = la.id
       where la.library_id = ${libraryId} group by la.id`;
    for (const r of rows) before.set(r.title, { id: r.id, fileIds: r.files });
    albumCount = await albumCountNow();
    expect(albumCount).toBe(6); // the two Set discs are one album
    expect(before.get('Set')!.fileIds.length).toBe(4);
    await sql`update local_albums set state = 'matched' where library_id = ${libraryId}`;
    for (const b of before.values()) {
      await sql`insert into field_locks (library_id, scope, scope_id, field, value, created_by)
                values (${libraryId}, 'album', ${b.id}, 'title', ${JSON.stringify('locked')}::text::jsonb, ${userId})`;
    }
  });

  afterAll(async () => {
    await sql`delete from field_locks where library_id = ${libraryId}`;
    await sql`delete from local_albums where library_id = ${libraryId}`;
    await sql`delete from scan_roots where id in (${rootA}, ${rootB})`;
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
    await rm(pathA, { recursive: true, force: true });
    await rm(pathB, { recursive: true, force: true });
  });

  it('folder rename', async () => {
    await rename(path.join(pathA, 'Solo/Album One'), path.join(pathA, 'Solo/Album One (2001)'));
    await scanRootJob(ctx, { scanRootId: rootA, mode: 'full' });
    // both folders of the merge are queued without the throttle slot
    const sends = queue.filter((j) => j.name === 'cluster.dir' && j.data.dirPath.startsWith('Solo/'));
    expect(sends.map((j) => j.data.dirPath).sort()).toEqual(['Solo/Album One', 'Solo/Album One (2001)']);
    for (const j of sends) expect(j.opts.singletonSeconds).toBeUndefined();
    await drain();
    await expectKept('Album One', ['Solo/Album One (2001)']);
    expect(await albumCountNow()).toBe(albumCount);
  });

  it('folder rename found by a folder rescan (scan.dir)', async () => {
    await rename(path.join(pathA, 'Solo/Album One (2001)'), path.join(pathA, 'Solo/Album One [2001]'));
    await scanDirJob(ctx, { scanRootId: rootA, dirPath: 'Solo' });
    const sends = queue.filter((j) => j.name === 'cluster.dir' && j.data.dirPath.startsWith('Solo/'));
    expect(sends.map((j) => j.data.dirPath).sort()).toEqual(['Solo/Album One (2001)', 'Solo/Album One [2001]']);
    for (const j of sends) expect(j.opts.singletonSeconds).toBeUndefined();
    await drain();
    await expectKept('Album One', ['Solo/Album One [2001]']);
    expect(await albumCountNow()).toBe(albumCount);
  });

  it('artist folder rename with three albums', async () => {
    await rename(path.join(pathA, 'Band'), path.join(pathA, 'The Band'));
    await scanRootJob(ctx, { scanRootId: rootA, mode: 'full' });
    await drain();
    await expectKept('First', ['The Band/First']);
    await expectKept('Second', ['The Band/Second']);
    await expectKept('Third', ['The Band/Third']);
    expect(await albumCountNow()).toBe(albumCount);
  });

  it('disc set moved together (sibling disc folders, clustered concurrently)', async () => {
    await mkdir(path.join(pathA, 'Boxes'));
    await rename(path.join(pathA, 'Box/Set CD1'), path.join(pathA, 'Boxes/Set CD1'));
    await rename(path.join(pathA, 'Box/Set CD2'), path.join(pathA, 'Boxes/Set CD2'));
    await scanRootJob(ctx, { scanRootId: rootA, mode: 'full' });
    await drain();
    await expectKept('Set', ['Boxes/Set CD1', 'Boxes/Set CD2']);
    expect(await albumCountNow()).toBe(albumCount);
  });

  it('move to another root', async () => {
    await mkdir(path.join(pathB, 'Travel'));
    await rename(path.join(pathA, 'Travel/Away'), path.join(pathB, 'Travel/Away'));
    await scanRootJob(ctx, { scanRootId: rootA, mode: 'full' }); // the old rows go missing
    await drain();
    await scanRootJob(ctx, { scanRootId: rootB, mode: 'full' }); // the new rows pair with them
    const sends = queue.filter((j) => j.name === 'cluster.dir');
    expect(sends.map((j) => `${j.data.scanRootId === rootA ? 'A' : 'B'}:${j.data.dirPath}`).sort()).toEqual(['A:Travel/Away', 'B:Travel/Away']);
    await drain();
    await expectKept('Away', ['Travel/Away']);
    const roots = await sql`select distinct scan_root_id::text as r from audio_files where id = any(${before.get('Away')!.fileIds}::uuid[])`;
    expect(roots.map((r: any) => r.r)).toEqual([rootB]);
    expect(await albumCountNow()).toBe(albumCount);
  });
});

/**
 * The zero-track sweeps of one cluster.dir against another job filling an
 * album (ledger: parked race). The filling job holds the album key lock from
 * its upsert until its tracks commit; the sweep must wait and then see the
 * tracks, never delete the album (and with it, by cascade, the new tracks).
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)('zero-track sweep vs a concurrent fill (db)', () => {
  let ctx: WorkerContext; let sql: any;
  const userId = randomUUID(); const libraryId = randomUUID(); const rootId = randomUUID();
  const album = async (key: string, dir: string, state: string) => (await sql`
    insert into local_albums (library_id, cluster_key, state, dir_paths) values (${libraryId}, ${key}, ${state}, ${[dir]}::text[])
    returning id::text as id`)[0].id as string;
  const file = async (relPath: string) => (await sql`
    insert into audio_files (library_id, scan_root_id, rel_path, status) values (${libraryId}, ${rootId}, ${relPath}, 'present')
    returning id::text as id`)[0].id as string;
  const exists = async (id: string) => (await sql`select 1 from local_albums where id = ${id}`).length === 1;

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    sql = made.client;
    ctx = { db: made.db, sql: made.client, boss: { send: async () => randomUUID() } as any, logger: pino({ level: 'silent' }) };
    await sql`insert into users (id, email, password_hash) values (${userId}, ${`race-${userId}@test.com`}, 'x')`;
    await sql`insert into libraries (id, name, owner_user_id, settings) values (${libraryId}, 'RACE', ${userId}, '{}')`;
    await sql`insert into scan_roots (id, library_id, path, display_name) values (${rootId}, ${libraryId}, '/nonexistent-race', 'race')`;
  });

  afterAll(async () => {
    await sql`delete from local_albums where library_id = ${libraryId}`;
    await sql`delete from scan_roots where id = ${rootId}`;
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
  });

  it('an album being filled under its key lock survives the sweep with its tracks', async () => {
    const key = `race-${randomUUID()}`;
    const albumId = await album(key, 'Race/Fill', 'matched');
    const fileId = await file('Race/Fill/1.flac');
    let filled!: () => void;
    const inserted = new Promise<void>((r) => { filled = r; });
    const fill = sql.begin(async (tx: any) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${albumKeyLock(libraryId, key)}, 0))`;
      await tx`insert into local_tracks (local_album_id, audio_file_id, state, origin) values (${albumId}, ${fileId}, 'unmatched', 'file')`;
      filled();
      await new Promise((r) => setTimeout(r, 300));
    });
    await inserted;
    const [res] = await Promise.all([retireEmptyAlbums(ctx, libraryId, 'Race/Fill', ['Race/Fill']), fill]);
    expect(res.superseded).toEqual([]);
    expect(await exists(albumId)).toBe(true);
    expect((await sql`select local_album_id::text as a from local_tracks where audio_file_id = ${fileId}`).map((r: any) => r.a)).toEqual([albumId]);
  });

  it('a zero-track album nobody fills is still retired (both sweeps)', async () => {
    const pending = await album(`race-${randomUUID()}`, 'Race/Empty', 'pending');
    const matched = await album(`race-${randomUUID()}`, 'Race/Empty CD1', 'matched');
    const outside = await album(`race-${randomUUID()}`, 'Race/Elsewhere', 'matched');
    const res = await retireEmptyAlbums(ctx, libraryId, 'Race/Empty', ['Race/Empty', 'Race/Empty CD1']);
    expect(res.reaped.map((r) => r.id)).toEqual([pending]);
    expect(res.superseded.map((r) => r.id)).toEqual([matched]);
    expect(await exists(pending)).toBe(false);
    expect(await exists(matched)).toBe(false);
    expect(await exists(outside)).toBe(true);
  });
});

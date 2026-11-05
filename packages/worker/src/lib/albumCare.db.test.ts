/**
 * Library care follows the worker's album changes (rr85): a rescan that
 * finds the missing songs in the album's folder (cluster.dir) and a deletion
 * that removes a copy (the trash's dropDeletedFiles) put the album-level gaps
 * right at once and queue the quality check of the albums they touched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { files, libraries, localAlbums, scanRoots, users, makeDb } from '@tagave/db';
import { clusterDirJob } from '../jobs/clusterDir.js';
import { gapsRecomputeJob } from '../jobs/gapsRecompute.js';
import { dropDeletedFiles } from './deletions.js';

const silent = { info() {}, warn() {}, debug() {}, error() {}, trace() {}, fatal() {}, child() { return silent; } };

describe.skipIf(!process.env.TEST_DATABASE_URL)('Library care after worker album changes (db)', () => {
  let db: any;
  let sql: any;
  let ctx: any;
  const sent: Array<{ name: string; data: any }> = [];
  const userId = randomUUID();
  const libraryId = randomUUID();
  const rootId = randomUUID();
  const dir = 'Air/Talkie Walkie';
  const copyDir = 'Air/Talkie Walkie (copy)';
  let rgId = '';
  let relId = '';

  const addFile = async (folder: string, n: number) => {
    const id = randomUUID();
    await db.insert(files).values({
      handler: 'audio', id, libraryId, scanRootId: rootId, relPath: `${folder}/${String(n).padStart(2, '0')} - Track ${n}.flac`,
      sizeBytes: 1, mtime: 1, status: 'present', durationMs: 240_000, lossless: true, hasEmbeddedArt: true,
      tagsRaw: { common: { title: `Track ${n}`, artist: 'Air', albumartist: 'Air', album: 'Talkie Walkie', year: 2004, track: { no: n, of: 10 } } },
    });
    return id;
  };
  const albumIn = async (folder: string) =>
    (await db.select().from(localAlbums).where(eq(localAlbums.libraryId, libraryId)))
      .find((a: any) => (a.dirPaths ?? []).includes(folder));
  const match = async (albumId: string) =>
    sql`update local_albums set state = 'matched', release_id = ${relId}, release_group_id = ${rgId}, identified_at = now() where id = ${albumId}`;
  const open = async (kind: string, subjectId: string) => sql`
    select state from gaps where library_id = ${libraryId} and kind = ${kind} and subject_id = ${subjectId} and state in ('open', 'todo')`;

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    sql = made.client;
    ctx = { db, sql, boss: { send: async (name: string, data: unknown) => { sent.push({ name, data }); return randomUUID(); } }, logger: silent };
    await db.insert(users).values({ id: userId, email: `care-${userId}@test.com`, passwordHash: 'x' });
    await db.insert(libraries).values({ id: libraryId, name: 'Care', ownerUserId: userId });
    await db.insert(scanRoots).values({ id: rootId, libraryId, path: '/tmp/care-root', displayName: 'care', validationStatus: 'ok' });
    const [rg] = await sql`insert into release_groups (mbid, title) values (${randomUUID()}, 'Talkie Walkie') returning id::text as id`;
    rgId = rg.id;
    const [rel] = await sql`insert into releases (release_group_id, mbid, title, track_count) values (${rgId}, ${randomUUID()}, 'Talkie Walkie', 10) returning id::text as id`;
    relId = rel.id;
    for (let n = 1; n <= 10; n++) {
      await sql`insert into canonical_tracks (release_id, medium_no, position, title, length_ms) values (${relId}, 1, ${n}, ${`Track ${n}`}, 240000)`;
    }
    for (let n = 1; n <= 7; n++) await addFile(dir, n);
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: dir });
    await match((await albumIn(dir)).id);
    await gapsRecomputeJob(ctx, { libraryId });
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(scanRoots).where(eq(scanRoots.id, rootId));
    await db.delete(libraries).where(eq(libraries.id, libraryId)); // cascades albums, gaps
    await db.delete(users).where(eq(users.id, userId));
    await sql.end({ timeout: 5 });
  });

  it('a rescan that finds the missing songs in the folder: the album is no longer incomplete', async () => {
    const album = await albumIn(dir);
    expect(await open('incomplete_album', album.id)).toHaveLength(1);
    for (const n of [8, 9, 10]) await addFile(dir, n);
    sent.length = 0;
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: dir });
    expect((await albumIn(dir)).id).toBe(album.id);
    expect(await open('incomplete_album', album.id)).toEqual([]);
    expect(sent.find((s) => s.name === 'gaps.recompute')?.data).toEqual({ libraryId, albumIds: [album.id] });
  });

  it('the boot sweep puts right a gap an earlier version left stale (the album was completed meanwhile)', async () => {
    const album = await albumIn(dir);
    // as 0.25 left a merged album: complete, still listed as missing three songs
    await sql`update gaps set state = 'open', resolved_at = null
               where library_id = ${libraryId} and kind = 'incomplete_album' and subject_id = ${album.id}`;
    expect(await open('incomplete_album', album.id)).toHaveLength(1);
    await gapsRecomputeJob(ctx, { libraryId, albumGapsOnly: true });
    expect(await open('incomplete_album', album.id)).toEqual([]);
  });

  it('deleting a second copy resolves the duplicate it made', async () => {
    const ids: string[] = [];
    for (let n = 1; n <= 10; n++) ids.push(await addFile(copyDir, n));
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: copyDir });
    const copy = await albumIn(copyDir);
    await match(copy.id);
    await gapsRecomputeJob(ctx, { libraryId });
    expect(await open('duplicate', rgId)).toHaveLength(1);

    for (const id of ids) {
      await sql`insert into file_deletions (file_id, library_id, scan_root_id, kind, state, rel_path, created_by)
                select id, library_id, scan_root_id, 'mark', 'marked', rel_path, ${userId} from files where id = ${id}`;
    }
    const out = await dropDeletedFiles(ctx, ids);
    expect(out.albumsRemoved).toBe(1);
    expect(await open('duplicate', rgId)).toEqual([]);
    // and the nightly run agrees
    await gapsRecomputeJob(ctx, { libraryId });
    expect(await open('duplicate', rgId)).toEqual([]);
  });

  it('every file of a copy marked deleted: the copy is no longer a duplicate, nor its own problems', async () => {
    const ids: string[] = [];
    for (let n = 1; n <= 4; n++) ids.push(await addFile('Air/Talkie Walkie (part)', n));
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: 'Air/Talkie Walkie (part)' });
    const part = await albumIn('Air/Talkie Walkie (part)');
    await match(part.id);
    await gapsRecomputeJob(ctx, { libraryId });
    expect(await open('incomplete_album', part.id)).toHaveLength(1);
    expect(await open('duplicate', rgId)).toHaveLength(1);
    for (const id of ids) {
      await sql`insert into file_deletions (file_id, library_id, scan_root_id, kind, state, rel_path, created_by)
                select id, library_id, scan_root_id, 'mark', 'marked', rel_path, ${userId} from files where id = ${id}`;
    }
    await gapsRecomputeJob(ctx, { libraryId, albumIds: [part.id] });
    expect(await open('incomplete_album', part.id)).toEqual([]);
    expect(await open('duplicate', rgId)).toEqual([]);
    expect(await sql`select 1 from gaps where subject_id = ${part.id} and state in ('open', 'todo')`).toHaveLength(0);
  });
});

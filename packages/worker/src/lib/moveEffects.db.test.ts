/**
 * A folder.jpg cover survives a folder move, also when the source root is
 * scanned first (its sidecar is stale before anything pairs) and when the
 * pair is found later by Tier 2: the image row keeps its id and points at the
 * same-named sidecar in the new folder.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { makeDb } from '@tagave/db';
import type { WorkerContext } from './context.js';
import { walkRoot } from './walk.js';
import { placeHolds, releaseReadyHolds } from './clusterHold.js';
import { repointSidecarImages } from './moveEffects.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('sidecar covers follow moves (db)', () => {
  let ctx: WorkerContext; let sql: any; let base: string;
  const userId = randomUUID(); const libraryId = randomUUID(); const rootA = randomUUID(); const rootB = randomUUID();
  const A = () => ({ id: rootA, libraryId, path: path.join(base, 'a') });
  const B = () => ({ id: rootB, libraryId, path: path.join(base, 'b') });
  const sidecarOf = async (imageId: string) => (await sql`
    select s.scan_root_id, s.rel_path from images i join sidecar_files s on s.id = i.sidecar_file_id where i.id = ${imageId}`)[0];

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    sql = made.client;
    ctx = { db: made.db, sql: made.client, boss: { send: async () => randomUUID() } as any, logger: pino({ level: 'silent' }) };
    base = await mkdtemp(path.join(tmpdir(), 'tagave-sc-'));
    await mkdir(path.join(base, 'a', 'Album'), { recursive: true });
    await mkdir(path.join(base, 'b'), { recursive: true });
    await writeFile(path.join(base, 'a', 'Album', '1.flac'), 'one');
    await writeFile(path.join(base, 'a', 'Album', 'folder.jpg'), 'jpg');
    // a root that yields no files at all is treated as unmounted; keep one file in A
    await writeFile(path.join(base, 'a', 'keep.flac'), 'keep-this-one');
    await sql`insert into users (id, email, password_hash) values (${userId}, ${`sc-${userId}@test.com`}, 'x')`;
    await sql`insert into libraries (id, name, owner_user_id, settings) values (${libraryId}, 'SC', ${userId}, '{}')`;
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status) values
              (${rootA}, ${libraryId}, ${path.join(base, 'a')}, 'a', 'ok'), (${rootB}, ${libraryId}, ${path.join(base, 'b')}, 'b', 'ok')`;
    await walkRoot(ctx, A(), { mode: 'full' });
  });

  afterAll(async () => {
    await sql`delete from local_albums where library_id = ${libraryId}`;
    await sql`delete from scan_roots where library_id = ${libraryId}`;
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
    await rm(base, { recursive: true, force: true });
  });

  const cover = async () => {
    const albumId = randomUUID();
    await sql`insert into local_albums (id, library_id, cluster_key) values (${albumId}, ${libraryId}, ${`k:${albumId}`})`;
    const [sc] = await sql`select id from sidecar_files where library_id = ${libraryId} and rel_path like '%folder.jpg' order by last_seen_at desc limit 1`;
    const [img] = await sql`insert into images (library_id, entity_type, entity_id, local_album_id, kind, origin, sidecar_file_id, license_note)
                            values (${libraryId}, 'local_album', ${albumId}, ${albumId}, 'front', 'sidecar', ${sc.id}, 't') returning id`;
    return img.id as string;
  };

  it('same root: the image row points at the new folder.jpg', async () => {
    const img = await cover();
    await rename(path.join(base, 'a', 'Album'), path.join(base, 'a', 'Album (2001)'));
    await walkRoot(ctx, A(), { mode: 'full' });
    expect(await sidecarOf(img)).toEqual({ scan_root_id: rootA, rel_path: 'Album (2001)/folder.jpg' });
  });

  it('other root, source scanned first: the stale sidecar waits next to its missing files, then the image follows', async () => {
    const img = (await sql`select id from images where library_id = ${libraryId}`)[0].id;
    await rename(path.join(base, 'a', 'Album (2001)'), path.join(base, 'b', 'Album (2001)'));
    await walkRoot(ctx, A(), { mode: 'full' });
    expect(await sidecarOf(img)).toEqual({ scan_root_id: rootA, rel_path: 'Album (2001)/folder.jpg' }); // kept (Ruling 9)
    await walkRoot(ctx, B(), { mode: 'full' });
    expect(await sidecarOf(img)).toEqual({ scan_root_id: rootB, rel_path: 'Album (2001)/folder.jpg' });
    // the next scan of A drops the old sidecar row: nothing points at it, nothing is missing there
    await walkRoot(ctx, A(), { mode: 'full' });
    expect(await sql`select 1 from sidecar_files where scan_root_id = ${rootA}`).toHaveLength(0);
    expect(await sidecarOf(img)).toBeDefined();
  });
});

/**
 * The Tier 2 path (hold release, no walk) re-points too, and the name match:
 * normKey-folded names pair, an ambiguous fold re-points nothing, files in
 * subfolders are not the folder's sidecars.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)('repointSidecarImages (db)', () => {
  let ctx: WorkerContext; let sql: any;
  const userId = randomUUID(); const libraryId = randomUUID(); const rootId = randomUUID();
  const dayAgo = () => new Date(Date.now() - 86_400_000).toISOString();
  const sidecar = async (relPath: string) =>
    (await sql`insert into sidecar_files (library_id, scan_root_id, rel_path, kind) values (${libraryId}, ${rootId}, ${relPath}, 'image') returning id`)[0].id as string;
  const imageOn = async (sidecarId: string) => {
    const albumId = randomUUID();
    await sql`insert into local_albums (id, library_id, cluster_key) values (${albumId}, ${libraryId}, ${`k:${albumId}`})`;
    return (await sql`insert into images (library_id, entity_type, entity_id, local_album_id, kind, origin, sidecar_file_id, license_note)
                      values (${libraryId}, 'local_album', ${albumId}, ${albumId}, 'front', 'sidecar', ${sidecarId}, 't') returning id`)[0].id as string;
  };
  const pointsAt = async (imageId: string) => (await sql`select sidecar_file_id from images where id = ${imageId}`)[0].sidecar_file_id;
  const move = (fromDir: string, toDir: string) => ({ fromRootId: rootId, fromDir, toRootId: rootId, toDir, files: 1 });

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    sql = made.client;
    ctx = { db: made.db, sql: made.client, boss: { send: async () => randomUUID() } as any, logger: pino({ level: 'silent' }) };
    await sql`insert into users (id, email, password_hash) values (${userId}, ${`rp-${userId}@test.com`}, 'x')`;
    await sql`insert into libraries (id, name, owner_user_id, settings) values (${libraryId}, 'RP', ${userId}, '{}')`;
    await sql`insert into scan_roots (id, library_id, path, display_name) values (${rootId}, ${libraryId}, '/nonexistent-rp', 'rp')`;
  });

  afterAll(async () => {
    await sql`delete from audio_files where library_id = ${libraryId}`;
    await sql`delete from local_albums where library_id = ${libraryId}`;
    await sql`delete from scan_roots where id = ${rootId}`;
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
  });

  it('Tier 2: a pair found on hold release carries the cover to the new folder', async () => {
    const oldSc = await sidecar('T2Old/folder.jpg');
    const newSc = await sidecar('T2New/folder.jpg');
    const img = await imageOn(oldSc);
    const file = async (relPath: string, over: Record<string, unknown>) => {
      const id = randomUUID();
      await sql`insert into audio_files ${sql({ id, library_id: libraryId, scan_root_id: rootId, rel_path: relPath, size_bytes: 700, status: 'present',
                                                duration_ms: 31_000, core_tags_digest: 'rp1', ...over })}`;
      return id;
    };
    await file('T2Old/1.flac', { status: 'missing', last_seen_at: dayAgo() });
    const fresh = await file('T2New/1.flac', { tags_read_at: new Date().toISOString() });
    expect(await placeHolds(ctx, [fresh])).toEqual([fresh]);
    await releaseReadyHolds(ctx, [{ libraryId, scanRootId: rootId, dirPath: 'T2New' }]);
    expect(await pointsAt(img)).toBe(newSc);
  });

  it('matches names by normKey (case, NFC/NFD) and only directly in the folder', async () => {
    const oldSc = await sidecar('Fold/Folder.JPG');
    await sidecar('Fold2/Scans/folder.jpg'); // a subfolder's file is no second candidate
    const newSc = await sidecar('Fold2/folder.jpg');
    const img = await imageOn(oldSc);
    const nfdOld = await sidecar('Fold/Cove\u0301r.jpg');
    const nfcNew = await sidecar('Fold2/cov\u00e9r.jpg');
    const img2 = await imageOn(nfdOld);
    const nestedOld = await imageOn(await sidecar('Fold/Scans/folder.jpg')); // not in Fold itself
    expect(await repointSidecarImages(ctx, [move('Fold', 'Fold2')])).toBe(2);
    expect(await pointsAt(img)).toBe(newSc);
    expect(await pointsAt(img2)).toBe(nfcNew);
    expect(await pointsAt(nestedOld)).not.toBe(newSc);
  });

  it('two candidates for one folded name: nothing is re-pointed', async () => {
    const oldSc = await sidecar('Amb/folder.jpg');
    await sidecar('Amb2/folder.jpg');
    await sidecar('Amb2/FOLDER.jpg');
    const img = await imageOn(oldSc);
    expect(await repointSidecarImages(ctx, [move('Amb', 'Amb2')])).toBe(0);
    expect(await pointsAt(img)).toBe(oldSc);
  });

  it('no same-named sidecar in the new folder: the image stays where it is', async () => {
    const oldSc = await sidecar('Lone/folder.jpg');
    await sidecar('Lone2/cover.jpg');
    const img = await imageOn(oldSc);
    expect(await repointSidecarImages(ctx, [move('Lone', 'Lone2')])).toBe(0);
    expect(await pointsAt(img)).toBe(oldSc);
  });
});

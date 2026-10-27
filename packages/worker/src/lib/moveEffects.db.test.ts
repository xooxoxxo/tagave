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

  /** Old rows missing, fresh twins parsed and held, sidecars on both sides; then the hold is released. */
  const tier2 = async (pairs: Array<[string, string]>, size: number) => {
    const fresh: string[] = [];
    for (const [k, [from, to]] of pairs.entries()) {
      const common = { library_id: libraryId, scan_root_id: rootId, size_bytes: size + k, duration_ms: 31_000, core_tags_digest: `rp-${size}-${k}` };
      await sql`insert into audio_files ${sql({ ...common, id: randomUUID(), rel_path: from, status: 'missing', last_seen_at: dayAgo() })}`;
      const id = randomUUID();
      await sql`insert into audio_files ${sql({ ...common, id, rel_path: to, status: 'present', tags_read_at: new Date().toISOString() })}`;
      fresh.push(id);
    }
    expect(await placeHolds(ctx, fresh)).toHaveLength(fresh.length);
    const dirs = [...new Set(pairs.map(([, to]) => to.slice(0, to.lastIndexOf('/'))))];
    await releaseReadyHolds(ctx, dirs.map((dirPath) => ({ libraryId, scanRootId: rootId, dirPath })));
  };

  it('Tier 2: a pair found on hold release carries the cover to the new folder', async () => {
    const oldSc = await sidecar('T2Old/folder.jpg');
    const newSc = await sidecar('T2New/folder.jpg');
    const img = await imageOn(oldSc);
    await tier2([['T2Old/1.flac', 'T2New/1.flac']], 700);
    expect(await pointsAt(img)).toBe(newSc);
  });

  it('Tier 2: Album/Scans/folder.jpg follows the album', async () => {
    const img = await imageOn(await sidecar('T2s/Album/Scans/folder.jpg'));
    const newSc = await sidecar('T2s/Album (2001)/Scans/folder.jpg');
    await tier2([['T2s/Album/1.flac', 'T2s/Album (2001)/1.flac']], 720);
    expect(await pointsAt(img)).toBe(newSc);
    // a second run with the same move finds nothing left to re-point
    expect(await repointSidecarImages(ctx, [move('T2s/Album', 'T2s/Album (2001)')])).toBe(0);
  });

  it('Tier 2: Album/folder.jpg over CD1/CD2 follows the album', async () => {
    const img = await imageOn(await sidecar('T2d/Album/folder.jpg'));
    const newSc = await sidecar('T2d/Album (2001)/folder.jpg');
    await tier2([['T2d/Album/CD1/1.flac', 'T2d/Album (2001)/CD1/1.flac'], ['T2d/Album/CD2/1.flac', 'T2d/Album (2001)/CD2/1.flac']], 740);
    expect(await pointsAt(img)).toBe(newSc);
    expect(await repointSidecarImages(ctx, [move('T2d/Album/CD1', 'T2d/Album (2001)/CD1'), move('T2d/Album/CD2', 'T2d/Album (2001)/CD2')])).toBe(0);
  });

  it('matches relative paths by normKey (case, NFC/NFD), at any depth under the moved folder', async () => {
    const img = await imageOn(await sidecar('Fold/Folder.JPG'));
    const newSc = await sidecar('Fold2/folder.jpg');
    const img2 = await imageOn(await sidecar('Fold/Covér.jpg'));
    const nfcNew = await sidecar('Fold2/covér.jpg');
    const img3 = await imageOn(await sidecar('Fold/Scans/folder.jpg'));
    const nestedNew = await sidecar('Fold2/Scans/folder.jpg');
    expect(await repointSidecarImages(ctx, [move('Fold', 'Fold2')])).toBe(3);
    expect(await pointsAt(img)).toBe(newSc);
    expect(await pointsAt(img2)).toBe(nfcNew);
    expect(await pointsAt(img3)).toBe(nestedNew);
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

  it('a folder that still holds audio did not move as a whole: its cover stays', async () => {
    const oldSc = await sidecar('Part/folder.jpg');
    await sidecar('Part2/folder.jpg');
    const img = await imageOn(oldSc);
    await sql`insert into audio_files ${sql({ id: randomUUID(), library_id: libraryId, scan_root_id: rootId, rel_path: 'Part/2.flac', size_bytes: 1, status: 'present' })}`;
    expect(await repointSidecarImages(ctx, [move('Part', 'Part2')])).toBe(0);
    expect(await pointsAt(img)).toBe(oldSc);
  });

  it('thousands of gone rows: a folder holding only them is unoccupied, and the cover follows', async () => {
    // the gone ids go over once and are anti-joined by index (not `<> all(array)` per row)
    const gone = (await sql`
      insert into audio_files (library_id, scan_root_id, rel_path, size_bytes, status)
      select ${libraryId}, ${rootId}, 'Bulk/Album/CD1/' || g || '.flac', g, 'present' from generate_series(1, 3000) g
      returning id`).map((r: any) => r.id as string);
    await sql`insert into audio_files ${sql({ id: randomUUID(), library_id: libraryId, scan_root_id: rootId, rel_path: 'Bulk/Other/1.flac', size_bytes: 1, status: 'present' })}`;
    const img = await imageOn(await sidecar('Bulk/Album/folder.jpg'));
    const newSc = await sidecar('Bulk/Album (2001)/folder.jpg');
    expect(await repointSidecarImages(ctx, [move('Bulk/Album/CD1', 'Bulk/Album (2001)/CD1')], gone)).toBe(1);
    expect(await pointsAt(img)).toBe(newSc);
    // without the gone ids the same rows occupy the folder and nothing moves
    const oldBack = await sidecar('Bulk/Album/back.jpg');
    const img2 = await imageOn(oldBack);
    await sidecar('Bulk/Album (2001)/back.jpg');
    expect(await repointSidecarImages(ctx, [move('Bulk/Album/CD1', 'Bulk/Album (2001)/CD1')])).toBe(0);
    expect(await pointsAt(img2)).toBe(oldBack);
  });

  it('the climb stops below a parent that still holds audio (mirrored trees)', async () => {
    // Mir/Album/CD1 -> Mir2/Album/CD1 would strip to Mir -> Mir2, but Mir still has another album
    const stays = await imageOn(await sidecar('Mir/Other/folder.jpg'));
    await sidecar('Mir2/Other/folder.jpg');
    const follows = await imageOn(await sidecar('Mir/Album/folder.jpg'));
    const newSc = await sidecar('Mir2/Album/folder.jpg');
    await sql`insert into audio_files ${sql({ id: randomUUID(), library_id: libraryId, scan_root_id: rootId, rel_path: 'Mir/Other/1.flac', size_bytes: 1, status: 'present' })}`;
    expect(await repointSidecarImages(ctx, [move('Mir/Album/CD1', 'Mir2/Album/CD1')])).toBe(1);
    expect(await pointsAt(follows)).toBe(newSc);
    expect(await pointsAt(stays)).not.toBe(newSc);
  });
});

/**
 * Covers outside the audio folder, through real walks: Album/Scans/folder.jpg
 * over audio in Album/, and Album/folder.jpg over audio in Album/CD1, CD2.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)('covers outside the audio folder follow (db)', () => {
  let ctx: WorkerContext; let sql: any;
  const made: Array<{ userId: string; libraryId: string; base: string }> = [];
  const layouts = {
    scans: { files: ['Album/1.flac', 'Album/2.flac', 'Album/Scans/folder.jpg'], cover: 'Scans/folder.jpg' },
    discs: { files: ['Album/CD1/1.flac', 'Album/CD2/1.flac', 'Album/folder.jpg'], cover: 'folder.jpg' },
  } as const;
  const sidecarOf = async (imageId: string) => (await sql`
    select s.scan_root_id, s.rel_path from images i join sidecar_files s on s.id = i.sidecar_file_id where i.id = ${imageId}`)[0];

  beforeAll(async () => {
    const m = await makeDb(process.env.TEST_DATABASE_URL!);
    sql = m.client;
    ctx = { db: m.db, sql: m.client, boss: { send: async () => randomUUID() } as any, logger: pino({ level: 'silent' }) };
  });

  afterAll(async () => {
    for (const m of made) {
      await sql`delete from local_albums where library_id = ${m.libraryId}`;
      await sql`delete from scan_roots where library_id = ${m.libraryId}`;
      await sql`delete from libraries where id = ${m.libraryId}`;
      await sql`delete from users where id = ${m.userId}`;
      await rm(m.base, { recursive: true, force: true });
    }
    await sql.end({ timeout: 5 });
  });

  /** Root a with the layout and one more file (an empty root reads as unmounted), root b empty; a walked; a cover on the sidecar. */
  const lab = async (layout: keyof typeof layouts) => {
    const userId = randomUUID(); const libraryId = randomUUID(); const rootA = randomUUID(); const rootB = randomUUID();
    const base = await mkdtemp(path.join(tmpdir(), 'tagave-scl-'));
    made.push({ userId, libraryId, base });
    await mkdir(path.join(base, 'b'), { recursive: true });
    for (const [i, f] of layouts[layout].files.entries()) {
      await mkdir(path.dirname(path.join(base, 'a', f)), { recursive: true });
      await writeFile(path.join(base, 'a', f), `${layout}-${i}-`.repeat(i + 1));
    }
    await writeFile(path.join(base, 'a', 'keep.flac'), 'keep-this-one');
    await sql`insert into users (id, email, password_hash) values (${userId}, ${`scl-${userId}@test.com`}, 'x')`;
    await sql`insert into libraries (id, name, owner_user_id, settings) values (${libraryId}, 'SCL', ${userId}, '{}')`;
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status) values
              (${rootA}, ${libraryId}, ${path.join(base, 'a')}, 'a', 'ok'), (${rootB}, ${libraryId}, ${path.join(base, 'b')}, 'b', 'ok')`;
    const A = { id: rootA, libraryId, path: path.join(base, 'a') };
    const B = { id: rootB, libraryId, path: path.join(base, 'b') };
    await walkRoot(ctx, A, { mode: 'full' });
    const albumId = randomUUID();
    await sql`insert into local_albums (id, library_id, cluster_key) values (${albumId}, ${libraryId}, ${`k:${albumId}`})`;
    const [sc] = await sql`select id from sidecar_files where scan_root_id = ${rootA} and rel_path = ${`Album/${layouts[layout].cover}`}`;
    const [img] = await sql`insert into images (library_id, entity_type, entity_id, local_album_id, kind, origin, sidecar_file_id, license_note)
                            values (${libraryId}, 'local_album', ${albumId}, ${albumId}, 'front', 'sidecar', ${sc.id}, 't') returning id`;
    return { A, B, base, img: img.id as string, rootA, rootB, cover: layouts[layout].cover };
  };

  for (const layout of ['scans', 'discs'] as const) {
    it(`${layout}: same-root rename`, async () => {
      const l = await lab(layout);
      await rename(path.join(l.base, 'a', 'Album'), path.join(l.base, 'a', 'Album (2001)'));
      await walkRoot(ctx, l.A, { mode: 'full' });
      expect(await sidecarOf(l.img)).toEqual({ scan_root_id: l.rootA, rel_path: `Album (2001)/${l.cover}` });
      expect(await sql`select 1 from sidecar_files where scan_root_id = ${l.rootA} and rel_path like 'Album/%'`).toHaveLength(0);
    });

    it(`${layout}: other root, source scanned first`, async () => {
      const l = await lab(layout);
      await rename(path.join(l.base, 'a', 'Album'), path.join(l.base, 'b', 'Album'));
      await walkRoot(ctx, l.A, { mode: 'full' });
      expect(await sidecarOf(l.img)).toEqual({ scan_root_id: l.rootA, rel_path: `Album/${l.cover}` }); // kept (Ruling 9, widened)
      await walkRoot(ctx, l.B, { mode: 'full' });
      expect(await sidecarOf(l.img)).toEqual({ scan_root_id: l.rootB, rel_path: `Album/${l.cover}` });
      await walkRoot(ctx, l.A, { mode: 'full' });
      expect(await sql`select 1 from sidecar_files where scan_root_id = ${l.rootA}`).toHaveLength(0);
    });
  }
});

/**
 * A failed cover re-point after a folder move must not lose the cover: the
 * walk keeps the stale sidecars (their images would cascade away with them).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { makeDb } from '@tagave/db';
import type { WorkerContext } from './context.js';

vi.mock('./moveEffects.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./moveEffects.js')>()),
  repointSidecarImages: async () => { throw new Error('sidecar update failed'); },
}));
const { walkRoot } = await import('./walk.js');

describe.skipIf(!process.env.TEST_DATABASE_URL)('cover re-point fails during a move (db)', () => {
  let ctx: WorkerContext; let sql: any; let base: string;
  const warn = vi.fn();
  const userId = randomUUID(); const libraryId = randomUUID(); const rootId = randomUUID();
  const root = () => ({ id: rootId, libraryId, path: base });

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    sql = made.client;
    ctx = { db: made.db, sql: made.client, boss: { send: async () => randomUUID() } as any, logger: Object.assign(pino({ level: 'silent' }), { warn }) };
    base = await mkdtemp(path.join(tmpdir(), 'tagave-rpf-'));
    await mkdir(path.join(base, 'Album'), { recursive: true });
    await writeFile(path.join(base, 'Album', '1.flac'), 'one');
    await writeFile(path.join(base, 'Album', 'folder.jpg'), 'jpg');
    await writeFile(path.join(base, 'keep.flac'), 'keep-this-one');
    await sql`insert into users (id, email, password_hash) values (${userId}, ${`rpf-${userId}@test.com`}, 'x')`;
    await sql`insert into libraries (id, name, owner_user_id, settings) values (${libraryId}, 'RPF', ${userId}, '{}')`;
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status) values (${rootId}, ${libraryId}, ${base}, 'rpf', 'ok')`;
    await walkRoot(ctx, root(), { mode: 'full' });
  });

  afterAll(async () => {
    await sql`delete from local_albums where library_id = ${libraryId}`;
    await sql`delete from scan_roots where library_id = ${libraryId}`;
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
    await rm(base, { recursive: true, force: true });
  });

  it('keeps the old sidecar row and its image, and says why', async () => {
    const albumId = randomUUID();
    await sql`insert into local_albums (id, library_id, cluster_key) values (${albumId}, ${libraryId}, ${`k:${albumId}`})`;
    const [sc] = await sql`select id from sidecar_files where scan_root_id = ${rootId} and rel_path = 'Album/folder.jpg'`;
    const [img] = await sql`insert into images (library_id, entity_type, entity_id, local_album_id, kind, origin, sidecar_file_id, license_note)
                            values (${libraryId}, 'local_album', ${albumId}, ${albumId}, 'front', 'sidecar', ${sc.id}, 't') returning id`;
    await rename(path.join(base, 'Album'), path.join(base, 'Album (2001)'));
    warn.mockClear();
    await walkRoot(ctx, root(), { mode: 'full' });
    // the move merged (the file row kept its id) but the cover stayed put
    expect(await sql`select rel_path from audio_files where scan_root_id = ${rootId} and rel_path like 'Album%'`).toEqual([{ rel_path: 'Album (2001)/1.flac' }]);
    expect(await sql`select 1 from sidecar_files where id = ${sc.id}`).toHaveLength(1);
    expect(await sql`select sidecar_file_id from images where id = ${img.id}`).toEqual([{ sidecar_file_id: sc.id }]);
    expect(warn.mock.calls.map((c) => c[1])).toContain('scan.finish: stale sidecars kept, the cover re-point failed');
  });
});

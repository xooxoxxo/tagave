/**
 * Move to album (0080) against the real server on a scratch database: owner
 * only, the picker's albums, a move asked for (files.move plan, or search for
 * a release with no folder), songs of another album refused, Move refused
 * while tag writes are off, on a read-only folder or with a name taken, then
 * queued; Undo while it runs and after.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import postgres from 'postgres';
import type { AuthHandle } from '@tagave/auth';

const sent: Array<{ name: string; data: unknown }> = [];
vi.mock('../boss.js', () => ({
  getBoss: async () => ({
    send: async (name: string, data: unknown) => { sent.push({ name, data }); return 'job'; },
    createQueue: async () => undefined,
  }),
}));

const { registerApiRoutes } = await import('../app.js');
const { initAuth } = await import('../middleware/auth.js');
const { TEST_PUBLIC_URL, createScratchDb, migrateAll, testAuth } = await import('../testkit/authApp.js');
const { createTestUser } = await import('../testkit/users.js');
const { initDb } = await import('../db.js');
type TestUser = Awaited<ReturnType<typeof createTestUser>>;

const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('moving songs to another album (integration)', () => {
  let db: { url: string; name: string };
  let sql: postgres.Sql;
  let handle: AuthHandle;
  let app: FastifyInstance;
  let owner: TestUser;
  let editor: TestUser;
  let libraryId = '';
  const rootId = randomUUID();
  const vertebrae = randomUUID();
  const isa = randomUUID();
  const loose = randomUUID();
  const trackIds: string[] = [];
  let isaTrack = '';

  const call = (u: TestUser, method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method, url: `/api/v1${url}`, headers: { cookie: u.cookie, origin: TEST_PUBLIC_URL }, ...(payload ? { payload } : {}) });
  const moves = (albumId = vertebrae) => `/libraries/${libraryId}/albums/${albumId}/moves`;
  const move = (id: string) => `/libraries/${libraryId}/moves/${id}`;

  beforeAll(async () => {
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    db = await createScratchDb(adminUrl!, admin);
    await admin.end({ timeout: 2 });
    await migrateAll(db.url);
    await initDb(db.url);
    handle = testAuth(db.url);
    initAuth(handle);
    sql = postgres(db.url, { max: 2, onnotice: () => undefined });
    owner = await createTestUser(handle, { role: 'owner' });
    editor = await createTestUser(handle, { role: 'editor' });
    const [lib] = await sql<Array<{ id: string }>>`insert into libraries (owner_user_id, name, settings) values (${owner.userId}, 'Music', '{}'::jsonb) returning id::text as id`;
    libraryId = lib!.id;
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status, writable, probe_writable)
              values (${rootId}, ${libraryId}, '/mnt/music', 'Music', 'ok', true, false)`;
    const [rg] = await sql<Array<{ id: string }>>`insert into release_groups (mbid, title) values (${randomUUID()}, 'Isa') returning id::text as id`;
    const [rel] = await sql<Array<{ id: string }>>`insert into releases (release_group_id, mbid, title, track_count) values (${rg!.id}, ${randomUUID()}, 'Isa', 2) returning id::text as id`;
    for (const [id, title, state, names] of [
      [vertebrae, 'Vertebrae', 'matched', ['01 - Clouds.flac', '03 - Isa.flac']],
      [isa, 'Isa', 'matched', ['01 - Intro.flac']],
      [loose, 'Unknown', 'unidentified', ['x.flac']],
    ] as const) {
      await sql`insert into local_albums (id, library_id, cluster_key, title_guess, artist_guess, state, track_count, release_id, release_group_id, dir_paths)
                values (${id}, ${libraryId}, ${`ck-${id}`}, ${title}, 'Enslaved', ${state}, ${names.length},
                        ${state === 'matched' ? rel!.id : null}, ${state === 'matched' ? rg!.id : null}, ${[`Enslaved/${title}`]})`;
      for (const name of names) {
        const [f] = await sql<Array<{ id: string }>>`insert into files (library_id, scan_root_id, rel_path, container, duration_ms, size_bytes, status, handler)
                  values (${libraryId}, ${rootId}, ${`Enslaved/${title}/${name}`}, 'FLAC', 300000, 1000, 'present', 'audio') returning id::text as id`;
        const [t] = await sql<Array<{ id: string }>>`insert into local_tracks (local_album_id, audio_file_id, track_no, title_guess, origin)
                  values (${id}, ${f!.id}, 1, ${name}, 'file') returning id::text as id`;
        if (id === vertebrae) trackIds.push(t!.id);
        if (id === isa) isaTrack = t!.id;
      }
    }
    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    await registerApiRoutes(app, { backupService: { dir: '/nonexistent' } as never });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
    await sql?.end({ timeout: 2 });
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`drop database if exists ${db.name} with (force)`).catch(() => undefined);
    await admin.end({ timeout: 2 });
  });

  it('owner only', async () => {
    expect((await call(editor, 'GET', `/libraries/${libraryId}/moves`)).statusCode).toBe(403);
    expect((await call(editor, 'GET', `/libraries/${libraryId}/moves/albums?q=isa`)).statusCode).toBe(403);
    expect((await call(editor, 'POST', moves(), { trackIds, target: { albumId: isa } })).statusCode).toBe(403);
    expect((await call(editor, 'POST', `${move(randomUUID())}/undo`)).statusCode).toBe(403);
  });

  it('the picker finds albums by title or artist, ignoring accents', async () => {
    const r = (await call(owner, 'GET', `/libraries/${libraryId}/moves/albums?q=%C3%8Dsa`)).json();
    expect(r.items.map((a: { id: string }) => a.id)).toEqual([isa]);
    expect(r.items[0]).toMatchObject({ title: 'Isa', artist: 'Enslaved', tracks: 1, folder: 'Enslaved/Isa', matched: true });
    expect((await call(owner, 'GET', `/libraries/${libraryId}/moves/albums?q=`)).json()).toEqual({ items: [] });
  });

  it('refuses songs of another album, the same album and an album that is not identified', async () => {
    expect((await call(owner, 'POST', moves(), { trackIds: [isaTrack], target: { albumId: isa } })).statusCode).toBe(404);
    expect((await call(owner, 'POST', moves(), { trackIds, target: { albumId: vertebrae } })).statusCode).toBe(409);
    expect((await call(owner, 'POST', moves(), { trackIds, target: { albumId: loose } })).statusCode).toBe(409);
    expect((await call(owner, 'POST', moves(), { trackIds: [], target: { albumId: isa } })).statusCode).toBe(400);
  });

  it('a search for a release with no folder goes to the worker first', async () => {
    const r = await call(owner, 'POST', moves(), { trackIds, target: { search: { artist: 'Enslaved', title: 'Ruun' } } });
    expect(r.statusCode).toBe(202);
    const view = r.json();
    expect(view).toMatchObject({ state: 'searching', candidates: null, plan: null });
    expect(sent.at(-1)).toEqual({ name: 'files.move', data: { moveId: view.id, action: 'search' } });
    // a release it found, then planning
    await sql`update album_moves set state = 'choosing' where id = ${view.id}`;
    const mbid = randomUUID();
    const picked = await call(owner, 'POST', `${move(view.id)}/target`, { target: { releaseMbid: mbid } });
    expect(picked.statusCode).toBe(202);
    expect(picked.json().state).toBe('planning');
    expect((await sql`select release_mbid::text as m from album_moves where id = ${view.id}`)[0]!['m']).toBe(mbid);
    expect(sent.at(-1)).toEqual({ name: 'files.move', data: { moveId: view.id, action: 'plan' } });
  });

  it('Move: refused while tag writes are off, on a read-only folder and with a name taken; then queued; Undo', async () => {
    const r = await call(owner, 'POST', moves(), { trackIds, target: { albumId: isa } });
    const id = r.json().id;
    expect(sent.at(-1)).toEqual({ name: 'files.move', data: { moveId: id, action: 'plan' } });
    expect((await call(owner, 'POST', `${move(id)}/run`)).statusCode).toBe(409);
    const plan = {
      scanRootId: rootId, toDir: 'Enslaved/Isa', newFolder: false, naming: '01 - Title',
      release: { id: randomUUID(), mbid: null, title: 'Isa', artist: 'Enslaved', year: 2004, tracks: 2 },
      files: [{ fileId: randomUUID(), localTrackId: trackIds[1], title: 'Isa', fromPath: 'Enslaved/Vertebrae/03 - Isa.flac',
        toPath: 'Enslaved/Isa/02 - Isa.flac', target: null, confidence: 98, diff: [], stays: null, clash: false }],
    };
    await sql`update album_moves set state = 'ready', plan = ${sql.json(plan)} where id = ${id}`;
    const off = await call(owner, 'POST', `${move(id)}/run`);
    expect(off.statusCode).toBe(409);
    expect(off.json().detail).toBe('Tag writes are off');
    expect((await call(owner, 'GET', move(id))).json().blocked).toBe('Tag writes are off');
    await sql`update libraries set settings = '{"tagWritesEnabled": true}'::jsonb where id = ${libraryId}`;
    expect((await call(owner, 'POST', `${move(id)}/run`)).json().detail).toBe('Music folder is read-only');
    await sql`update scan_roots set probe_writable = true where id = ${rootId}`;
    await sql`update album_moves set plan = jsonb_set(plan, '{files,0,clash}', 'true') where id = ${id}`;
    expect((await call(owner, 'POST', `${move(id)}/run`)).json().detail).toBe('A new name is taken in the folder');
    await sql`update album_moves set plan = jsonb_set(plan, '{files,0,clash}', 'false') where id = ${id}`;
    const ok = await call(owner, 'POST', `${move(id)}/run`);
    expect(ok.statusCode).toBe(202);
    expect(ok.json()).toMatchObject({ state: 'moving', undoable: true, blocked: null });
    expect(sent.at(-1)).toEqual({ name: 'files.move', data: { moveId: id, action: 'move' } });
    expect((await call(owner, 'POST', `${move(id)}/run`)).statusCode).toBe(409);

    // Undo while it runs: the worker undoes it as it ends
    const n = sent.length;
    expect((await call(owner, 'POST', `${move(id)}/undo`)).statusCode).toBe(202);
    expect(sent.length).toBe(n);
    expect((await sql`select undo_requested as u from album_moves where id = ${id}`)[0]!['u']).toBe(true);
    // done: Undo queues the undo
    await sql`update album_moves set state = 'done', undo_requested = false, finished_at = now(),
                     journal = ${sql.json({ scanRootId: rootId, files: [{ fileId: plan.files[0]!.fileId, fromPath: 'a', toPath: 'b', before: {}, after: {}, diff: [], tagged: false, moved: true }], trashedDir: null, madeDir: null, pins: [] })}
               where id = ${id}`;
    const list = (await call(owner, 'GET', `/libraries/${libraryId}/moves`)).json();
    expect(list.items[0]).toMatchObject({ id, state: 'done', title: 'Isa', toDir: 'Enslaved/Isa', fromDir: '', files: 1, undoable: true });
    const undo = await call(owner, 'POST', `${move(id)}/undo`);
    expect(undo.statusCode).toBe(202);
    expect(undo.json().state).toBe('undoing');
    expect(sent.at(-1)).toEqual({ name: 'files.move', data: { moveId: id, action: 'undo' } });
    expect((await call(owner, 'POST', `${move(id)}/undo`)).statusCode).toBe(409);
  });
});

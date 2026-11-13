/**
 * Naming rules, the drop pool, Organize and Inbox (0081) against the real
 * server on a scratch database: owner only; the rules detected from the
 * library before they are saved, three examples, bad templates refused; the
 * pool turned on in the first writable folder (the worker asked to make it),
 * a folder of the library refused; Organize lists the misfiled album and
 * queues its move; Inbox's actions; a plan's Organize files switch.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import postgres from 'postgres';
import type { AuthHandle } from '@tagave/auth';

const sent: Array<{ name: string; data: any }> = [];
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

describe.skipIf(!adminUrl)('naming rules and the drop pool (integration)', () => {
  let db: { url: string; name: string };
  let sql: postgres.Sql;
  let handle: AuthHandle;
  let app: FastifyInstance;
  let owner: TestUser;
  let editor: TestUser;
  let libraryId = '';
  const rootId = randomUUID();
  const misfiled = randomUUID();
  let itemId = '';
  let releaseId = '';

  const call = (u: TestUser, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    app.inject({ method, url: `/api/v1/libraries/${libraryId}${url}`, headers: { cookie: u.cookie, origin: TEST_PUBLIC_URL }, ...(payload ? { payload } : {}) });

  const common = (album: string, artist: string, title: string, track: number, year: number) =>
    ({ common: { album, albumartist: artist, artist, title, track: { no: track, of: null }, year } });

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
              values (${rootId}, ${libraryId}, '/mnt/music', 'Music', 'ok', true, true)`;
    // three albums filed the owner's way, one misfiled
    const albums: Array<[string, string, string, number, Array<[string, string]>]> = [
      [randomUUID(), 'Ryuichi Sakamoto', 'Out Of Noise', 2009, [['R/Ryuichi Sakamoto/2009 - Out Of Noise/07 - Firewater.mp3', 'Firewater']]],
      [randomUUID(), 'The Peoples Republic Of Europe', 'Machine District', 2012, [['P/The Peoples Republic Of Europe/2012 - Machine District/09 - Centurion.flac', 'Centurion']]],
      [randomUUID(), 'Fiona Apple', 'when the pawn', 1999, [['F/Fiona Apple/1999 - when the pawn/04 - love ridden.mp3', 'love ridden']]],
      [misfiled, 'Low', 'Things We Lost in the Fire', 2001, [['misc/low/1 sunflower.flac', 'Sunflower']]],
    ];
    for (const [id, artist, title, year, files] of albums) {
      await sql`insert into local_albums (id, library_id, cluster_key, title_guess, artist_guess, state, track_count, dir_paths)
                values (${id}, ${libraryId}, ${`ck-${id}`}, ${title}, ${artist}, 'unidentified', ${files.length}, ${[files[0]![0].slice(0, files[0]![0].lastIndexOf('/'))]})`;
      for (const [relPath, song] of files) {
        const track = Number(/\/(\d+)[^/]*$/.exec(relPath)?.[1] ?? 1);
        const [f] = await sql<Array<{ id: string }>>`insert into files (library_id, scan_root_id, rel_path, container, duration_ms, size_bytes, status, handler, tags_raw)
                  values (${libraryId}, ${rootId}, ${relPath}, 'FLAC', 300000, 1000, 'present', 'audio', ${sql.json(common(title, artist, song, track, year) as never)}) returning id::text as id`;
        await sql`insert into local_tracks (local_album_id, audio_file_id, track_no, title_guess, origin) values (${id}, ${f!.id}, ${track}, ${song}, 'file')`;
      }
    }
    const [rg] = await sql<Array<{ id: string }>>`insert into release_groups (mbid, title) values (${randomUUID()}, 'Ghost World') returning id::text as id`;
    const [rel] = await sql<Array<{ id: string }>>`insert into releases (release_group_id, mbid, title, track_count) values (${rg!.id}, ${randomUUID()}, 'Ghost World', 1) returning id::text as id`;
    releaseId = rel!.id;
    const [it] = await sql<Array<{ id: string }>>`
      insert into pool_items (library_id, scan_root_id, dir_path, state, reason, files, candidates, best_release_id, best_percent, pairing)
      values (${libraryId}, ${rootId}, '_Inbox/Ghost World', 'inbox', 'unsure', ${sql.json([{ relPath: '_Inbox/Ghost World/1.flac', size: 1 }] as never)},
              ${sql.json([{ releaseId, mbid: null, title: 'Ghost World', artist: 'Various Artists', year: 2001, country: null, format: null, tracks: 1, percent: 81 }] as never)},
              ${releaseId}, 81, '[]'::jsonb)
      returning id::text as id`;
    itemId = it!.id;
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
    for (const [m, u] of [['GET', '/naming'], ['GET', '/drop-pool'], ['GET', '/organize'], ['GET', '/inbox']] as const) {
      expect((await call(editor, m, u)).statusCode).toBe(403);
    }
  });

  it('detects the library\'s pattern before rules are saved, with three examples; refuses a bad template', async () => {
    const v = (await call(owner, 'GET', '/naming')).json();
    expect(v.saved).toBe(false);
    expect(v.detected).toMatchObject({ found: true, sampled: 4 });
    expect(v.rules).toMatchObject({ folder: '{initial}/{albumartist}/[{year} - ]{album}', file: '[{disc}-][{track:02} - ]{title}', leaveAlone: ['#', '_duplicates'] });
    expect(v.examples).toHaveLength(3);
    const bad = await call(owner, 'PUT', '/naming', { rules: { ...v.rules, folder: '{albumartist}/{nope}' } });
    expect(bad.statusCode).toBe(400);
    expect((await call(owner, 'POST', '/naming/examples', { rules: { ...v.rules, file: '{artist}' } })).json().problems).toEqual({ file: 'Needs {title} or {track}' });
    const saved = (await call(owner, 'PUT', '/naming', { rules: v.rules })).json();
    expect(saved).toMatchObject({ saved: true, detected: null });
  });

  it('turns the pool on in the first writable folder and asks the worker to make it; never a folder of the library', async () => {
    sent.length = 0;
    expect((await call(owner, 'PUT', '/drop-pool', { enabled: true, dirPath: 'misc' })).statusCode).toBe(409);
    expect((await call(owner, 'PUT', '/drop-pool', { enabled: true, dirPath: '../x' })).statusCode).toBe(400);
    const v = (await call(owner, 'PUT', '/drop-pool', { enabled: true })).json();
    expect(v).toMatchObject({ enabled: true, scanRootId: rootId, dirPath: '_Inbox', path: '/mnt/music/_Inbox', counts: { inbox: 1 } });
    expect(sent).toEqual([{ name: 'pool.scan', data: { libraryId, create: true } }]);
    // the worker has not looked yet: no line
    expect(v.state).toBeNull();
  });

  it('shows what the file worker found, for this pool only', async () => {
    const put = (s: unknown) => sql`update libraries set settings = settings || jsonb_build_object('dropPoolStatus', ${JSON.stringify(s)}::text::jsonb) where id = ${libraryId}`;
    const at = new Date().toISOString();
    for (const state of ['ready', 'unreachable', 'missing'] as const) {
      await put({ state, scanRootId: rootId, dirPath: '_Inbox', seenReady: true, at });
      expect((await call(owner, 'GET', '/drop-pool')).json().state).toBe(state);
    }
    // a status about another folder is not this pool's
    await put({ state: 'ready', scanRootId: rootId, dirPath: 'Elsewhere', seenReady: true, at });
    expect((await call(owner, 'GET', '/drop-pool')).json().state).toBeNull();
  });

  it('Organize lists the misfiled album and queues its move', async () => {
    const v = (await call(owner, 'GET', '/organize')).json();
    expect(v.inPlace).toBe(3);
    expect(v.wrongFolder.map((a: { albumId: string }) => a.albumId)).toEqual([misfiled]);
    expect(v.wrongFolder[0]).toMatchObject({ fromDir: 'misc/low', toDir: 'L/Low/2001 - Things We Lost in the Fire', sample: { to: 'L/Low/2001 - Things We Lost in the Fire/01 - Sunflower.flac' } });
    sent.length = 0;
    expect((await call(owner, 'POST', '/organize', { albumIds: [misfiled] })).json()).toEqual({ queued: 1 });
    expect(sent[0]).toMatchObject({ name: 'files.move', data: { action: 'plan' } });
    const [m] = await sql`select kind, state, source_album_id::text as src from album_moves where id = ${sent[0]!.data.moveId}`;
    expect(m).toMatchObject({ kind: 'organize', state: 'planning', src: misfiled });
    // a second ask while it waits queues nothing
    expect((await call(owner, 'POST', '/organize', { albumIds: [misfiled] })).json()).toEqual({ queued: 0 });
  });

  it('Inbox: lists, Accept queues an import, Skip keeps the files', async () => {
    const list = (await call(owner, 'GET', '/inbox')).json();
    expect(list.items[0]).toMatchObject({ id: itemId, reason: 'unsure', folder: 'Ghost World', best: { percent: 81 }, toDir: '_Various Artists/2001 - Ghost World' });
    expect((await call(owner, 'POST', `/inbox/${itemId}`, { action: 'replace' })).statusCode).toBe(409);
    sent.length = 0;
    const accepted = (await call(owner, 'POST', `/inbox/${itemId}`, { action: 'accept' })).json();
    expect(accepted.state).toBe('importing');
    expect(sent[0]).toMatchObject({ name: 'files.move', data: { action: 'plan' } });
    const [m] = await sql`select kind, query from album_moves where id = ${sent[0]!.data.moveId}`;
    expect(m).toMatchObject({ kind: 'import', query: { poolItemId: itemId, releaseId } });
    // not waiting any more: Skip refused; back in Inbox, Skip marks it
    expect((await call(owner, 'POST', `/inbox/${itemId}`, { action: 'skip' })).statusCode).toBe(409);
    await sql`update pool_items set state = 'inbox' where id = ${itemId}`;
    expect((await call(owner, 'POST', `/inbox/${itemId}`, { action: 'skip' })).json().state).toBe('skipped');
  });

  it('a plan organizes by default once rules are saved, and its switch previews it again', async () => {
    const created = await app.inject({
      method: 'POST', url: `/api/v1/libraries/${libraryId}/tag-plans`, headers: { cookie: owner.cookie, origin: TEST_PUBLIC_URL },
      payload: { name: 'Low', scope: { type: 'albumIds', albumIds: [misfiled] }, policy: { preset: 'canonical_ids_and_fill', id3Version: '2.4', multiValueSeparator: '; ' } },
    });
    expect(created.statusCode).toBeLessThan(300);
    const plan = created.json();
    expect(plan.policy.organize).toBe(true);
    sent.length = 0;
    expect((await call(owner, 'POST', `/tag-plans/${plan.id}/organize`, { on: false })).json()).toEqual({ organize: false });
    expect(sent).toEqual([{ name: 'tags.preview', data: { planId: plan.id } }]);
    const [p] = await sql`select policy, status from tag_plans where id = ${plan.id}`;
    expect(p).toMatchObject({ status: 'draft', policy: { organize: false } });
  });
});

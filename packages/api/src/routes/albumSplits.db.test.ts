/**
 * Whole album in one file (0078) against the real server on a scratch
 * database: owner only, a plan asked for (files.split analyze), one being
 * found kept, Split refused on a read-only folder or without a ready plan,
 * Split queued (files.split split), and an album that does not fit refused.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import postgres from 'postgres';
import { setLidarrEnabled, setModuleSettings, syncInstalledModules } from '@tagave/db';
import { ledgerEntries } from '@tagave/core/facets';
import type { AuthHandle } from '@tagave/auth';

const sent: Array<{ name: string; data: unknown }> = [];
vi.mock('../boss.js', () => ({
  getBoss: async () => ({
    send: async (name: string, data: unknown, options?: { id?: string }) => { sent.push({ name, data }); return options?.id ?? 'job'; },
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

describe.skipIf(!adminUrl)('album split and FLAC upgrade requests (integration)', () => {
  let db: { url: string; name: string };
  let sql: postgres.Sql;
  let handle: AuthHandle;
  let app: FastifyInstance;
  let owner: TestUser;
  let editor: TestUser;
  let libraryId = '';
  const rootId = randomUUID();
  const albumId = randomUUID();
  const twoFiles = randomUUID();
  let trackId = '';

  const call = (u: TestUser, method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method, url: `/api/v1${url}`, headers: { cookie: u.cookie, origin: TEST_PUBLIC_URL }, ...(payload ? { payload } : {}) });
  const base = (id = albumId) => `/libraries/${libraryId}/albums/${id}/split`;

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
    const [rg] = await sql<Array<{ id: string }>>`insert into release_groups (mbid, title) values (${randomUUID()}, 'Strapping Young Lad') returning id::text as id`;
    const [rel] = await sql<Array<{ id: string }>>`insert into releases (release_group_id, mbid, title, track_count) values (${rg!.id}, ${randomUUID()}, 'Strapping Young Lad', 2) returning id::text as id`;
    await sql`insert into canonical_tracks (release_id, medium_no, position, title, length_ms)
              values (${rel!.id}, 1, 1, 'One', 1200000), (${rel!.id}, 1, 2, 'Two', 1144000)`;
    for (const [id, names] of [[albumId, ['10 - Bring on the Young.flac']], [twoFiles, ['01.flac', '02.flac']]] as const) {
      await sql`insert into local_albums (id, library_id, cluster_key, title_guess, artist_guess, state, track_count, release_id, release_group_id)
                values (${id}, ${libraryId}, ${`ck-${id}`}, 'Strapping Young Lad', 'Strapping Young Lad', 'matched', ${names.length}, ${rel!.id}, ${rg!.id})`;
      for (const name of names) {
        const [f] = await sql<Array<{ id: string }>>`insert into files (library_id, scan_root_id, rel_path, container, lossless, duration_ms, size_bytes, status, handler)
                  values (${libraryId}, ${rootId}, ${`SYL/${id}/${name}`}, 'FLAC', true, ${names.length === 1 ? 2_344_000 : 1_172_000}, 1000, 'present', 'audio') returning id::text as id`;
        const [t] = await sql<Array<{ id: string }>>`insert into local_tracks (local_album_id, audio_file_id, track_no, title_guess, origin)
                  values (${id}, ${f!.id}, 10, ${name}, 'file') returning id::text as id`;
        if (id === albumId) trackId = t!.id;
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
    expect((await call(editor, 'GET', base())).statusCode).toBe(403);
    expect((await call(editor, 'POST', base())).statusCode).toBe(403);
    expect((await call(editor, 'POST', `${base()}/${randomUUID()}/run`)).statusCode).toBe(403);
  });

  it('says whether the album fits and the folder is writable', async () => {
    expect((await call(owner, 'GET', base())).json()).toEqual({ split: null, eligible: true, writable: false, localTrackId: trackId, tracks: 2 });
    expect((await call(owner, 'GET', base(twoFiles))).json()).toMatchObject({ split: null, eligible: false, localTrackId: null });
  });

  it('refuses an album that is not one file that fits', async () => {
    expect((await call(owner, 'POST', base(twoFiles))).statusCode).toBe(409);
  });

  it('finds a legacy analysis with no queue job and retries the same split', async () => {
    const [legacy] = await sql<{ id: string }[]>`
      insert into album_splits (library_id, local_album_id, file_id, release_id, state)
      select la.library_id, la.id, lt.audio_file_id, la.release_id, 'analyzing'
      from local_albums la join local_tracks lt on lt.local_album_id = la.id where la.id = ${albumId}
      returning id
    `;
    expect((await call(owner, 'GET', base())).json().split).toMatchObject({
      id: legacy!.id, state: 'failed', retryAnalysis: true,
    });
    const recovered = await call(owner, 'POST', base());
    expect(recovered.json().split).toMatchObject({
      id: legacy!.id, state: 'analyzing', task: { state: 'waiting', workerAvailable: false },
    });
  });

  it('asks the file worker for the cut points; a second ask keeps the one being found', async () => {
    const r = await call(owner, 'POST', base());
    expect(r.statusCode).toBe(202);
    const split = r.json().split;
    expect(split).toMatchObject({ state: 'analyzing', plan: null });
    expect(sent.at(-1)).toEqual({ name: 'files.split', data: { splitId: split.id, action: 'analyze', maintenance: { taskId: expect.any(String), attemptId: expect.any(String) } } });
    const again = await call(owner, 'POST', base());
    expect(again.json().split.id).toBe(split.id);
    expect(sent.filter((s) => s.name === 'files.split')).toHaveLength(1);
  });

  it('Split: refused without a ready plan or on a read-only folder, then queued', async () => {
    const { split } = (await call(owner, 'GET', base())).json();
    await sql`update scan_roots set probe_writable = true where id = ${rootId}`;
    expect((await call(owner, 'POST', `${base()}/${split.id}/run`)).statusCode).toBe(409);
    await sql`update album_splits set state = 'ready', plan = '{"tracks": []}'::jsonb where id = ${split.id}`;
    await sql`update scan_roots set probe_writable = false where id = ${rootId}`;
    const ro = await call(owner, 'POST', `${base()}/${split.id}/run`);
    expect(ro.statusCode).toBe(409);
    expect(ro.json().detail).toBe('The music folder is read-only');
    await sql`update scan_roots set probe_writable = true where id = ${rootId}`;
    const ok = await call(owner, 'POST', `${base()}/${split.id}/run`);
    expect(ok.statusCode).toBe(202);
    expect(ok.json().split.state).toBe('splitting');
    expect(sent.at(-1)).toEqual({ name: 'files.split', data: { splitId: split.id, action: 'split', maintenance: { taskId: expect.any(String), attemptId: expect.any(String) } } });
    // not twice
    expect((await call(owner, 'POST', `${base()}/${split.id}/run`)).statusCode).toBe(409);
  });

  it('queues one upgrade for an eligible owner and shows it after reload', async () => {
    const path = `/libraries/${libraryId}/albums/${twoFiles}/flac-upgrade`;
    expect((await call(editor, 'GET', path)).statusCode).toBe(403);
    expect((await call(editor, 'POST', path)).statusCode).toBe(403);
    expect((await call(owner, 'GET', path)).json()).toEqual({ eligible: false, task: null });
    await syncInstalledModules(sql, ledgerEntries());
    await setLidarrEnabled(sql, true);
    await setModuleSettings(sql, 'lidarr', { url: 'http://fixture.test', apiKey: 'fixture', useDropPool: true });
    await sql`update libraries set settings = settings || ${JSON.stringify({ dropPool: { enabled: true, scanRootId: rootId, dirPath: 'Pool' } })}::text::jsonb where id = ${libraryId}`;
    const [artist] = await sql<{ id: string }[]>`insert into artists (mbid, name) values (${randomUUID()}, 'Fixture') returning id`;
    await sql`insert into release_group_artists (release_group_id, artist_id, position)
      select release_group_id, ${artist!.id}, 1 from local_albums where id = ${twoFiles}`;
    expect((await call(owner, 'POST', path)).statusCode).toBe(409);
    await sql`update files set container = 'MPEG' where id in (select audio_file_id from local_tracks where local_album_id = ${twoFiles})`;
    await sql`with numbered as (
      select lt.id, row_number() over (order by f.rel_path)::int as position
      from local_tracks lt join files f on f.id = lt.audio_file_id where lt.local_album_id = ${twoFiles}
    )
    update local_tracks lt set track_no = numbered.position from numbered where lt.id = numbered.id`;
    expect((await call(owner, 'GET', path)).json()).toEqual({ eligible: true, task: null });
    const [one, two] = await Promise.all([call(owner, 'POST', path), call(owner, 'POST', path)]);
    expect(one.statusCode, one.body).toBe(202);
    expect(two.json().id).toBe(one.json().id);
    expect((await call(owner, 'GET', path)).json()).toMatchObject({
      eligible: false, task: { id: one.json().id, kind: 'flac-upgrade', state: 'waiting' },
    });
    expect(sent.filter((job) => job.name === 'files.upgrade')).toHaveLength(1);
  });
});

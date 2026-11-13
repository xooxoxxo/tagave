/**
 * Deleting songs and albums (0073) against the real server on a scratch
 * database: Mark and Trash, one mode at a time (Trash only with a writable
 * music folder), the song or album leaving the albums, the album page,
 * search, counts and playlists at once, Unmark bringing back everything it
 * had, the Deleting page and its delete command, and owner-only access.
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

describe.skipIf(!adminUrl)('deleting songs and albums (integration)', () => {
  let db: { url: string; name: string };
  let sql: postgres.Sql;
  let handle: AuthHandle;
  let app: FastifyInstance;
  let owner: TestUser;
  let editor: TestUser;
  let libraryId = '';
  const rootId = randomUUID();
  const ids: Record<string, string> = {};
  const files: Record<string, string> = {};
  const albumA = randomUUID();
  const albumB = randomUUID();

  const call = (u: TestUser, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    app.inject({ method, url: `/api/v1${url}`, headers: { cookie: u.cookie, origin: TEST_PUBLIC_URL }, ...(payload ? { payload } : {}) });
  const albumIds = async () => (await call(owner, 'GET', `/libraries/${libraryId}/albums?limit=100`)).json().items.map((a: any) => a.id).sort();

  beforeAll(async () => {
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    db = await createScratchDb(adminUrl!, admin);
    await admin.end({ timeout: 2 });
    await migrateAll(db.url);
    await initDb(db.url);
    handle = testAuth(db.url);
    initAuth(handle);
    sql = postgres(db.url, { max: 2, onnotice: () => undefined });
    // the album page asks pg-boss for queued identify jobs: an empty job table answers
    await sql`create schema if not exists pgboss`;
    await sql`create table if not exists pgboss.job (id uuid, name text, state text, singleton_key text, data jsonb, priority int, output jsonb, created_on timestamptz, started_on timestamptz, completed_on timestamptz)`;
    owner = await createTestUser(handle, { role: 'owner' });
    editor = await createTestUser(handle, { role: 'editor' });
    const [lib] = await sql<Array<{ id: string }>>`insert into libraries (owner_user_id, name, settings) values (${owner.userId}, 'Music', '{}'::jsonb) returning id::text as id`;
    libraryId = lib!.id;
    // read-only until a test says otherwise; the host folder as the file worker reported it
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status, writable, probe_writable, host_path)
              values (${rootId}, ${libraryId}, '/mnt/music', 'Music', 'ok', true, false, '/srv/music')`;
    await sql`insert into local_albums (id, library_id, cluster_key, title_guess, artist_guess, state, track_count, total_duration_ms)
              values (${albumA}, ${libraryId}, 'ck-a', 'Kind of Blue', 'Miles Davis', 'matched', 2, 900000),
                     (${albumB}, ${libraryId}, 'ck-b', 'Kind of Blue', 'Miles Davis', 'matched', 2, 900000)`;
    const track = async (key: string, albumId: string, no: number, title: string, rel: string) => {
      const fileId = randomUUID();
      await sql`insert into files (id, library_id, scan_root_id, rel_path, container, lossless, duration_ms, size_bytes, status, handler)
                values (${fileId}, ${libraryId}, ${rootId}, ${rel}, 'flac', true, 450000, 1000, 'present', 'audio')`;
      const [t] = await sql<Array<{ id: string }>>`insert into local_tracks (local_album_id, audio_file_id, track_no, title_guess, artist_guess, duration_ms, origin)
                values (${albumId}, ${fileId}, ${no}, ${title}, 'Miles Davis', 450000, 'file') returning id::text as id`;
      ids[key] = t!.id;
      files[key] = fileId;
    };
    await track('so', albumA, 1, 'So What', 'Miles Davis/Kind of Blue/01 So What.flac');
    await track('freddie', albumA, 2, 'Freddie Freeloader', "Miles Davis/Kind of Blue/02 Freddie's Freeloader.flac");
    await track('so2', albumB, 1, 'So What', 'Miles Davis/Kind of Blue (copy)/01 So What.flac');
    await track('freddie2', albumB, 2, 'Freddie Freeloader', 'Miles Davis/Kind of Blue (copy)/02 Freddie Freeloader.flac');
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
    expect((await call(editor, 'GET', `/libraries/${libraryId}/deletions/mode`)).statusCode).toBe(403);
    expect((await call(editor, 'POST', `/libraries/${libraryId}/deletions`, { trackIds: [ids['so']!] })).statusCode).toBe(403);
    expect((await call(editor, 'GET', `/libraries/${libraryId}/deletions`)).statusCode).toBe(403);
  });

  it('Mark by default; Trash refused while no music folder is writable', async () => {
    expect((await call(owner, 'GET', `/libraries/${libraryId}/deletions/mode`)).json()).toEqual({ mode: 'mark', trashAvailable: false });
    expect((await call(owner, 'PUT', `/libraries/${libraryId}/deletions/mode`, { mode: 'trash' })).statusCode).toBe(409);
  });

  it('a marked song leaves the album page, search, counts and the albums count at once', async () => {
    const before = (await call(owner, 'GET', `/libraries/${libraryId}/stats`)).json();
    const res = await call(owner, 'POST', `/libraries/${libraryId}/deletions`, { trackIds: [ids['so2']!] });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ marked: 1, trashed: 0 });
    const page = (await call(owner, 'GET', `/libraries/${libraryId}/albums/${albumB}`)).json();
    expect(page.tracks.map((t: any) => t.title)).toEqual(['Freddie Freeloader']);
    expect(page.trackCount).toBe(1);
    const card = (await call(owner, 'GET', `/libraries/${libraryId}/albums?limit=100`)).json().items.find((a: any) => a.id === albumB);
    expect(card.trackCount).toBe(1);
    const found = (await call(owner, 'GET', `/libraries/${libraryId}/search?q=so%20what`)).json();
    expect(found.tracks.map((t: any) => t.id)).toEqual([ids['so']]);
    const after = (await call(owner, 'GET', `/libraries/${libraryId}/stats`)).json();
    expect(after.tracks).toBe(before.tracks - 1);
    // the file itself is untouched; nothing is sent to the worker for a mark
    expect(sent.filter((s) => s.name === 'files.trash')).toEqual([]);
  });

  it('a marked album leaves the albums, its page (404), duplicates, search and the album count', async () => {
    await call(owner, 'POST', `/libraries/${libraryId}/deletions`, { albumIds: [albumB] });
    expect(await albumIds()).toEqual([albumA]);
    expect((await call(owner, 'GET', `/libraries/${libraryId}/albums/${albumB}`)).statusCode).toBe(404);
    expect((await call(owner, 'GET', `/libraries/${libraryId}/stats`)).json().albums).toBe(1);
    const found = (await call(owner, 'GET', `/libraries/${libraryId}/search?q=kind`)).json();
    expect(found.albums.map((a: any) => a.id)).toEqual([albumA]);
  });

  it('the Deleting page lists it with a command that deletes exactly those files on the host', async () => {
    const view = (await call(owner, 'GET', `/libraries/${libraryId}/deletions`)).json();
    expect(view.trash).toEqual([]);
    expect(view.marked).toHaveLength(1);
    expect(view.marked[0]).toMatchObject({ albumId: albumB, title: 'Kind of Blue', wholeAlbum: true, state: 'marked' });
    expect(view.marked[0].fileIds.sort()).toEqual([files['so2'], files['freddie2']].sort());
    expect(view.command).toBe(`cd '/srv/music' && rm -f -- 'Miles Davis/Kind of Blue (copy)/01 So What.flac' 'Miles Davis/Kind of Blue (copy)/02 Freddie Freeloader.flac'`);
  });

  it('Unmark brings the album back with everything it had', async () => {
    const view = (await call(owner, 'GET', `/libraries/${libraryId}/deletions`)).json();
    expect((await call(owner, 'POST', `/libraries/${libraryId}/deletions/unmark`, { fileIds: view.marked[0].fileIds })).json()).toEqual({ unmarked: 2 });
    expect(await albumIds()).toEqual([albumA, albumB].sort());
    const page = (await call(owner, 'GET', `/libraries/${libraryId}/albums/${albumB}`)).json();
    expect(page.tracks).toHaveLength(2);
    expect((await call(owner, 'GET', `/libraries/${libraryId}/deletions`)).json().command).toBeNull();
  });

  it('Trash on a writable folder: rows wait for the file worker; a read-only folder in the same library marks', async () => {
    await sql`update scan_roots set probe_writable = true where id = ${rootId}`;
    expect((await call(owner, 'PUT', `/libraries/${libraryId}/deletions/mode`, { mode: 'trash' })).json()).toEqual({ mode: 'trash', trashAvailable: true });
    const roRoot = randomUUID();
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status, writable, probe_writable) values (${roRoot}, ${libraryId}, '/mnt/other', 'Other', 'ok', false, false)`;
    await sql`update files set scan_root_id = ${roRoot} where id = ${files['freddie2']!}`;
    const res = (await call(owner, 'POST', `/libraries/${libraryId}/deletions`, { albumIds: [albumB] })).json();
    expect(res).toEqual({ marked: 1, trashed: 1 });
    expect(sent.filter((s) => s.name === 'files.trash').at(-1)).toEqual({ name: 'files.trash', data: { libraryId, action: 'move' } });
    const rows = await sql`select file_id::text as id, kind, state from file_deletions order by kind`;
    expect(rows.map((r) => [r.id, r.kind, r.state])).toEqual([[files['freddie2'], 'mark', 'marked'], [files['so2'], 'trash', 'moving']]);
    expect(await albumIds()).toEqual([albumA]);
    // with no host path known, the command uses the root's own path
    expect((await call(owner, 'GET', `/libraries/${libraryId}/deletions`)).json().command)
      .toBe(`cd '/mnt/other' && rm -f -- 'Miles Davis/Kind of Blue (copy)/02 Freddie Freeloader.flac'`);
  });

  it('Restore asks the worker only for what is in the trash; Empty trash is queued', async () => {
    expect((await call(owner, 'POST', `/libraries/${libraryId}/deletions/restore`, { fileIds: [files['so2']!] })).json()).toEqual({ restoring: 0 });
    await sql`update file_deletions set state = 'trashed', trash_rel_path = '.tagave-trash/2026-11-02/x.flac', trashed_at = now() where file_id = ${files['so2']!}`;
    expect((await call(owner, 'POST', `/libraries/${libraryId}/deletions/restore`, { fileIds: [files['so2']!] })).json()).toEqual({ restoring: 1 });
    expect(sent.filter((s) => s.name === 'files.trash').at(-1)).toEqual({ name: 'files.trash', data: { libraryId, action: 'restore' } });
    const url = `/libraries/${libraryId}/deletions/empty-trash`;
    const fileIds = [files['so2']!];
    expect((await call(owner, 'POST', url)).statusCode).toBe(400);
    expect((await call(owner, 'POST', url, { fileIds })).statusCode).toBe(409);
    await sql`update file_deletions set state = 'trashed' where file_id = ${fileIds[0]!}`;
    const started = await call(owner, 'POST', url, { fileIds });
    expect(started.statusCode, started.body).toBe(202);
    expect((await call(owner, 'POST', url, { fileIds })).statusCode).toBe(409);
    expect((await call(owner, 'POST', `/libraries/${libraryId}/deletions/restore`, { fileIds })).json()).toEqual({ restoring: 0 });
    expect((await call(owner, 'GET', `/libraries/${libraryId}/deletions`)).json().emptyTask).toMatchObject({
      fileIds, task: { state: 'waiting' },
    });
    const cancelled = await call(owner, 'POST', `/libraries/${libraryId}/maintenance-tasks/${started.json().id}/cancel`, {});
    expect(cancelled.json().state).toBe('cancelled');
    expect((await call(owner, 'POST', `/libraries/${libraryId}/deletions/restore`, { fileIds })).json()).toEqual({ restoring: 1 });
  });

  it('bad bodies are refused', async () => {
    expect((await call(owner, 'POST', `/libraries/${libraryId}/deletions`, {})).statusCode).toBe(400);
    expect((await call(owner, 'POST', `/libraries/${libraryId}/deletions`, { trackIds: ['nope'] })).statusCode).toBe(400);
    expect((await call(owner, 'PUT', `/libraries/${libraryId}/deletions/mode`, { mode: 'shred' })).statusCode).toBe(400);
  });
});

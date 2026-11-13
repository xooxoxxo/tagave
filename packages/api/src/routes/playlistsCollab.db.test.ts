/**
 * Collaborative playlists (0079) against the real server on scratch
 * databases:
 *
 *   permissions   the owner renames, deletes, manages collaborators, adds,
 *                 reorders and takes out any item; a collaborator views,
 *                 plays, adds, reorders and takes out what they added (the
 *                 rest 403); everyone else gets 404 on every route
 *   people        only active people of the same install can be turned on;
 *                 each change is in the audit log, once
 *   who added     each item names who put it there
 *   at once       two people adding and reordering at the same time leave
 *                 every item once, at its own position
 *   upgrade       0079 on a list made before it: every item the owner's,
 *                 positions renumbered in the order they showed
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import postgres from 'postgres';
import type { AuthHandle } from '@tagave/auth';

vi.mock('../boss.js', () => ({ getBoss: async () => ({ send: async () => 'job' }) }));

const { registerApiRoutes } = await import('../app.js');
const { initAuth } = await import('../middleware/auth.js');
const { TEST_PUBLIC_URL, createScratchDb, migrateAll, migrateUpTo, testAuth } = await import('../testkit/authApp.js');
const { createTestUser } = await import('../testkit/users.js');
const { initDb } = await import('../db.js');
type TestUser = Awaited<ReturnType<typeof createTestUser>>;

const adminUrl = process.env.TEST_DATABASE_URL;

async function scratch(): Promise<{ url: string; name: string }> {
  const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
  try {
    return await createScratchDb(adminUrl!, admin);
  } finally {
    await admin.end({ timeout: 2 });
  }
}

async function drop(name: string) {
  const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`drop database if exists ${name} with (force)`).catch(() => undefined);
  await admin.end({ timeout: 2 });
}

/** One album of `n` tracks; returns their ids in order. */
async function seedTracks(sql: postgres.Sql, libraryId: string, rootId: string, n: number): Promise<string[]> {
  const albumId = randomUUID();
  await sql`insert into local_albums (id, library_id, cluster_key, title_guess, artist_guess, state) values (${albumId}, ${libraryId}, ${`ck-${albumId}`}, 'Kind of Blue', 'Miles Davis', 'matched')`;
  const ids: string[] = [];
  for (let i = 1; i <= n; i++) {
    const fileId = randomUUID();
    const id = randomUUID();
    await sql`insert into files (id, library_id, scan_root_id, rel_path, container, codec, lossless, duration_ms, status, handler)
      values (${fileId}, ${libraryId}, ${rootId}, ${`Miles Davis/Kind of Blue/${String(i).padStart(2, '0')}.flac`}, 'flac', 'FLAC', true, 300000, 'present', 'audio')`;
    await sql`insert into local_tracks (id, local_album_id, audio_file_id, disc_no, track_no, title_guess, artist_guess, duration_ms, origin)
      values (${id}, ${albumId}, ${fileId}, 1, ${i}, ${`Track ${i}`}, 'Miles Davis', 300000, 'file')`;
    ids.push(id);
  }
  return ids;
}

describe.skipIf(!adminUrl)('collaborative playlists (integration)', () => {
  let db: { url: string; name: string };
  let sql: postgres.Sql;
  let handle: AuthHandle;
  let app: FastifyInstance;
  let owner: TestUser;
  let anna: TestUser;
  let ben: TestUser;
  let carl: TestUser;
  let tracks: string[] = [];
  let listId = '';

  const call = (u: TestUser, method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', url: string, payload?: object) =>
    app.inject({ method, url: `/api/v1${url}`, headers: { cookie: u.cookie, origin: TEST_PUBLIC_URL }, ...(payload ? { payload } : {}) });
  const audits = async () => (await sql<Array<{ action: string; actor: string; subject: string; who: string }>>`
    select action, actor_user_id::text as actor, subject_id::text as subject, payload->>'userId' as who from audit_log where action like 'playlist.%' order by at, id`).map((r) => ({ ...r }));

  beforeAll(async () => {
    db = await scratch();
    await migrateAll(db.url);
    await initDb(db.url);
    handle = testAuth(db.url);
    initAuth(handle);
    sql = postgres(db.url, { max: 4, onnotice: () => undefined });
    owner = await createTestUser(handle, { role: 'owner', name: 'Olive' });
    anna = await createTestUser(handle, { role: 'listener', name: 'Anna' });
    ben = await createTestUser(handle, { role: 'listener', name: 'Ben' });
    carl = await createTestUser(handle, { role: 'editor', name: 'Carl' });
    const [lib] = await sql<Array<{ id: string }>>`insert into libraries (owner_user_id, name, settings) values (${owner.userId}, 'Music', '{}'::jsonb) returning id::text as id`;
    const rootId = randomUUID();
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status) values (${rootId}, ${lib!.id}, '/mnt/music', 'Music', 'ok')`;
    tracks = await seedTracks(sql, lib!.id, rootId, 30);
    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    await registerApiRoutes(app, { backupService: { dir: '/nonexistent' } as never });
    await app.ready();
    // Anna's list: the owner of it is a listener, the people around her are the install's
    const res = await call(anna, 'POST', '/me/playlists', { name: 'Road trip', trackIds: tracks.slice(0, 3) });
    expect(res.statusCode).toBe(201);
    listId = res.json().id;
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
    await sql?.end({ timeout: 2 });
    if (db) await drop(db.name);
  });

  it('a list nobody shared: 404 on every route, the collaborators too', async () => {
    const id = listId;
    const item = (await call(anna, 'GET', `/me/playlists/${id}`)).json().items[0].id;
    for (const [m, u, body] of [
      ['GET', `/me/playlists/${id}`, undefined],
      ['PATCH', `/me/playlists/${id}`, { name: 'x' }],
      ['PATCH', `/me/playlists/${id}`, { order: [item] }],
      ['DELETE', `/me/playlists/${id}`, undefined],
      ['POST', `/me/playlists/${id}/items`, { trackIds: [tracks[5]] }],
      ['DELETE', `/me/playlists/${id}/items/${item}`, undefined],
      ['GET', `/me/playlists/${id}/export`, undefined],
      ['GET', `/me/playlists/${id}/collaborators`, undefined],
      ['PUT', `/me/playlists/${id}/collaborators/${ben.userId}`, { on: true }],
    ] as const) {
      expect((await call(ben, m, u, body)).statusCode, `${m} ${u}`).toBe(404);
    }
    // the install's owner is no exception: a person's list is theirs
    expect((await call(owner, 'GET', `/me/playlists/${id}`)).statusCode).toBe(404);
    expect((await call(ben, 'GET', '/me/playlists')).json().playlists).toEqual([]);
  });

  it('the owner’s sheet: the install’s other people (no one disabled or closed), each off', async () => {
    await sql`update users set disabled_at = now() where id = ${carl.userId}`;
    const people = (await call(anna, 'GET', `/me/playlists/${listId}/collaborators`)).json().people;
    expect(people).toEqual([
      { id: ben.userId, name: 'Ben', on: false },
      { id: owner.userId, name: 'Olive', on: false },
    ]);
    // a disabled person, someone of no install, and herself are refused
    expect((await call(anna, 'PUT', `/me/playlists/${listId}/collaborators/${carl.userId}`, { on: true })).statusCode).toBe(400);
    expect((await call(anna, 'PUT', `/me/playlists/${listId}/collaborators/${randomUUID()}`, { on: true })).statusCode).toBe(400);
    expect((await call(anna, 'PUT', `/me/playlists/${listId}/collaborators/${anna.userId}`, { on: true })).statusCode).toBe(400);
    expect((await call(anna, 'PUT', `/me/playlists/${listId}/collaborators/${ben.userId}`, { on: 'yes' })).statusCode).toBe(400);
    expect(await sql`select 1 from playlist_collaborators`).toHaveLength(0);
    await sql`update users set disabled_at = null where id = ${carl.userId}`;
  });

  it('turning Ben on: in the audit log once; he sees the list, collaborative, not his', async () => {
    const on = await call(anna, 'PUT', `/me/playlists/${listId}/collaborators/${ben.userId}`, { on: true });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().people.find((p: { id: string }) => p.id === ben.userId).on).toBe(true);
    // again: nothing changes, nothing more in the log
    await call(anna, 'PUT', `/me/playlists/${listId}/collaborators/${ben.userId}`, { on: true });
    expect(await audits()).toEqual([{ action: 'playlist.collaborator_add', actor: anna.userId, subject: listId, who: ben.userId }]);
    const bens = (await call(ben, 'GET', '/me/playlists')).json().playlists;
    expect(bens).toEqual([expect.objectContaining({ id: listId, name: 'Road trip', mine: false, collaborative: true })]);
    expect((await call(anna, 'GET', '/me/playlists')).json().playlists[0]).toMatchObject({ mine: true, collaborative: true });
    const view = (await call(ben, 'GET', `/me/playlists/${listId}`)).json();
    expect(view.owner).toEqual({ id: anna.userId, name: 'Anna' });
    expect(view.collaborators).toEqual([{ id: ben.userId, name: 'Ben' }]);
    expect(view.items.every((i: any) => i.addedBy?.id === anna.userId && i.removable === false)).toBe(true);
  });

  it('a collaborator adds, reorders and takes out what he added; the rest is the owner’s (403)', async () => {
    const added = await call(ben, 'POST', `/me/playlists/${listId}/items`, { trackIds: [tracks[10]!, tracks[11]!] });
    expect(added.statusCode, added.body).toBe(200);
    const view = added.json();
    expect(view.items.map((i: any) => i.addedBy.name)).toEqual(['Anna', 'Anna', 'Anna', 'Ben', 'Ben']);
    expect(view.items.map((i: any) => i.removable)).toEqual([false, false, false, true, true]);
    // reorder: his move, every item once
    const order = [...view.items].reverse().map((i: any) => i.id);
    const moved = await call(ben, 'PATCH', `/me/playlists/${listId}`, { order });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json().items.map((i: any) => i.id)).toEqual(order);
    // what only the owner does
    expect((await call(ben, 'PATCH', `/me/playlists/${listId}`, { name: 'Bens' })).statusCode).toBe(403);
    expect((await call(ben, 'PATCH', `/me/playlists/${listId}`, { name: 'Bens', order })).statusCode).toBe(403);
    expect((await call(ben, 'DELETE', `/me/playlists/${listId}`)).statusCode).toBe(403);
    expect((await call(ben, 'GET', `/me/playlists/${listId}/collaborators`)).statusCode).toBe(403);
    expect((await call(ben, 'PUT', `/me/playlists/${listId}/collaborators/${owner.userId}`, { on: true })).statusCode).toBe(403);
    const annas = view.items.find((i: any) => i.addedBy.id === anna.userId);
    expect((await call(ben, 'DELETE', `/me/playlists/${listId}/items/${annas.id}`)).statusCode).toBe(403);
    // his own: out
    const his = view.items.find((i: any) => i.addedBy.id === ben.userId);
    const out = await call(ben, 'DELETE', `/me/playlists/${listId}/items/${his.id}`);
    expect(out.statusCode).toBe(200);
    expect(out.json().items).toHaveLength(4);
    // the owner takes out his other one
    const other = out.json().items.find((i: any) => i.addedBy.id === ben.userId);
    expect((await call(anna, 'DELETE', `/me/playlists/${listId}/items/${other.id}`)).statusCode).toBe(200);
    // he plays it and exports it
    const file = await call(ben, 'GET', `/me/playlists/${listId}/export`);
    expect(file.statusCode).toBe(200);
    expect(JSON.parse(file.body).playlists.map((p: any) => [p.name, p.owner, p.items.length])).toEqual([['Road trip', undefined, 3]]);
    // his own export (every list of his) does not take hers
    expect(JSON.parse((await call(ben, 'GET', '/me/playlists/export')).body).playlists).toEqual([]);
    // the owner renames it; he sees the new name
    expect((await call(anna, 'PATCH', `/me/playlists/${listId}`, { name: 'Road trip 2' })).statusCode).toBe(200);
    expect((await call(ben, 'GET', `/me/playlists/${listId}`)).json().name).toBe('Road trip 2');
  });

  it('two people at once: every add lands, at its own position; a stale reorder is refused, never half-done', async () => {
    const before = (await call(anna, 'GET', `/me/playlists/${listId}`)).json().items.length;
    const adds = Array.from({ length: 12 }, (_, n) => call(n % 2 ? ben : anna, 'POST', `/me/playlists/${listId}/items`, { trackIds: [tracks[12 + n]!] }));
    // reorders from what each saw before the adds: refused once the list grew, done if they came first
    const seen = (await call(anna, 'GET', `/me/playlists/${listId}`)).json().items.map((i: any) => i.id);
    const reorders = [anna, ben, anna].map((u) => call(u, 'PATCH', `/me/playlists/${listId}`, { order: [...seen].reverse() }));
    const results = await Promise.all([...adds, ...reorders]);
    expect(results.slice(0, 12).map((r) => r.statusCode)).toEqual(Array(12).fill(200));
    for (const r of results.slice(12)) expect([200, 409]).toContain(r.statusCode);
    const rows = await sql<Array<{ position: number; local_track_id: string }>>`select position, local_track_id::text as local_track_id from playlist_items where playlist_id = ${listId} order by position`;
    expect(rows).toHaveLength(before + 12);
    expect(new Set(rows.map((r) => r.position)).size).toBe(rows.length);
    for (const t of tracks.slice(12, 24)) expect(rows.some((r) => r.local_track_id === t), t).toBe(true);
    // the view's order is the positions'
    const view = (await call(ben, 'GET', `/me/playlists/${listId}`)).json();
    expect(view.items).toHaveLength(rows.length);
    // positions stay unique, even written by hand
    await expect(sql.begin(async (tx) => {
      await tx`update playlist_items set position = 0 where playlist_id = ${listId}`;
    })).rejects.toThrow(/playlist_items_position_unique/);
  });

  it('turned off: Ben no longer finds it; in the audit log; his items stay, named', async () => {
    const off = await call(anna, 'PUT', `/me/playlists/${listId}/collaborators/${ben.userId}`, { on: false });
    expect(off.statusCode).toBe(200);
    expect((await call(ben, 'GET', `/me/playlists/${listId}`)).statusCode).toBe(404);
    expect((await call(ben, 'POST', `/me/playlists/${listId}/items`, { trackIds: [tracks[29]!] })).statusCode).toBe(404);
    expect((await call(ben, 'GET', '/me/playlists')).json().playlists).toEqual([]);
    expect((await audits()).map((a) => a.action)).toEqual(['playlist.collaborator_add', 'playlist.collaborator_remove']);
    const view = (await call(anna, 'GET', `/me/playlists/${listId}`)).json();
    expect(view).toMatchObject({ collaborative: false, collaborators: [] });
    expect(view.items.some((i: any) => i.addedBy?.name === 'Ben')).toBe(true);
  });

  it('a person deleted: their collaborations go, what they added stays with no name', async () => {
    await call(anna, 'PUT', `/me/playlists/${listId}/collaborators/${carl.userId}`, { on: true });
    await call(carl, 'POST', `/me/playlists/${listId}/items`, { trackIds: [tracks[28]!] });
    await sql`delete from users where id = ${carl.userId}`;
    expect(await sql`select 1 from playlist_collaborators where user_id = ${carl.userId}`).toHaveLength(0);
    const view = (await call(anna, 'GET', `/me/playlists/${listId}`)).json();
    expect(view.items.at(-1)).toMatchObject({ addedBy: null, removable: true });
  });
});

describe.skipIf(!adminUrl)('0079 on lists made before it (upgrade)', () => {
  it('every item is the owner’s; positions renumbered in the order they showed', async () => {
    const db = await scratch();
    const sql = postgres(db.url, { max: 1, onnotice: () => undefined });
    try {
      await migrateUpTo(db.url, '0079');
      const [u] = await sql<Array<{ id: string }>>`insert into users (email, display_name, password_hash, role) values ('old@example.test', 'Old', 'x', 'owner') returning id::text as id`;
      const [p] = await sql<Array<{ id: string }>>`insert into playlists (user_id, name) values (${u!.id}, 'Old list') returning id::text as id`;
      // two items at the same position (what a race could leave), one later
      await sql`insert into playlist_items (playlist_id, position, title, added_at) values
        (${p!.id}, 5, 'b', now() - interval '1 minute'), (${p!.id}, 5, 'c', now()), (${p!.id}, 2, 'a', now()), (${p!.id}, 9, 'd', now())`;
      await migrateAll(db.url);
      const rows = await sql`select title, position, added_by::text as added_by from playlist_items order by position`;
      expect(rows.map((r) => [r.title, r.position, r.added_by])).toEqual([['a', 0, u!.id], ['b', 1, u!.id], ['c', 2, u!.id], ['d', 3, u!.id]]);
      expect(await migrateAll(db.url)).toEqual([]);
    } finally {
      await sql.end({ timeout: 2 });
      await drop(db.name);
    }
  });
});

/**
 * The books app's routes (the spike) against the real server on a scratch
 * database: nothing at all without TAGAVE_DEV_APPS=books (404, no ledger
 * row, /facets lists music alone); with it, the Settings › Modules row,
 * turning it on (owner, step-up) makes the books library once, the works
 * list and covers for listeners, 409 while off, and a boot without the flag
 * turns it off again (its data stays).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import postgres from 'postgres';
import { APPS, MODULES, ledgerEntries } from '@tagave/core/facets';
import { moduleEnabled, setModuleEnabled, syncInstalledModules } from '@tagave/db';
import type { AuthHandle } from '@tagave/auth';

vi.mock('../boss.js', () => ({ getBoss: async () => ({ send: async () => 'job' }) }));

const { registerApiRoutes } = await import('../app.js');
const { initAuth } = await import('../middleware/auth.js');
const { TEST_PUBLIC_URL, createScratchDb, migrateAll, testAuth } = await import('../testkit/authApp.js');
const { createTestUser } = await import('../testkit/users.js');
const { initDb } = await import('../db.js');
const { turnOffDisallowedDevApps } = await import('../lib/devApps.js');
type TestUser = Awaited<ReturnType<typeof createTestUser>>;

const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('the books app routes, behind TAGAVE_DEV_APPS (integration)', () => {
  let db: { url: string; name: string };
  let sql: postgres.Sql;
  let handle: AuthHandle;
  let app: FastifyInstance;
  let owner: TestUser;
  let anna: TestUser;
  const flag = process.env['TAGAVE_DEV_APPS'];

  const call = (u: TestUser, method: 'GET' | 'PUT', url: string, payload?: object, headers: Record<string, string> = {}) =>
    app.inject({ method, url: `/api/v1${url}`, headers: { cookie: u.cookie, origin: TEST_PUBLIC_URL, ...headers }, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    delete process.env['TAGAVE_DEV_APPS'];
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    db = await createScratchDb(adminUrl!, admin);
    await admin.end({ timeout: 2 });
    await migrateAll(db.url);
    await initDb(db.url);
    handle = testAuth(db.url);
    initAuth(handle);
    sql = postgres(db.url, { max: 2, onnotice: () => undefined });
    owner = await createTestUser(handle, { role: 'owner' });
    anna = await createTestUser(handle, { role: 'listener' });
    await sql`insert into libraries (owner_user_id, name, settings) values (${owner.userId}, 'Music', '{}'::jsonb)`;
    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    await registerApiRoutes(app, { backupService: { dir: '/nonexistent' } as never });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    if (flag === undefined) delete process.env['TAGAVE_DEV_APPS'];
    else process.env['TAGAVE_DEV_APPS'] = flag;
    await app?.close();
    await handle?.close();
    await sql?.end({ timeout: 2 });
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`drop database if exists ${db.name} with (force)`).catch(() => undefined);
    await admin.end({ timeout: 2 });
  });

  it('without the flag: no row in the ledger, every books route 404, /facets lists music alone', async () => {
    expect(await syncInstalledModules(sql, ledgerEntries())).toEqual([]);
    expect(await sql`select id from installed_modules where id = 'books'`).toHaveLength(0);
    for (const [u, m, url] of [[anna, 'GET', '/books'], [owner, 'GET', '/settings/books'], [owner, 'PUT', '/settings/books'], [anna, 'GET', `/books/editions/${randomUUID()}/cover`]] as const) {
      expect((await call(u, m, url, m === 'PUT' ? { enabled: true } : undefined)).statusCode, url).toBe(404);
    }
    expect((await call(anna, 'GET', '/facets')).json().apps).toEqual(['music']);
    const libs = (await call(anna, 'GET', '/libraries')).json().data;
    expect(libs.map((l: { name: string; app: string }) => `${l.name} ${l.app}`)).toEqual(['Music music']);
  });

  it('with the flag: the row, off; on makes the books library once; listeners read works and covers; off answers 409', async () => {
    process.env['TAGAVE_DEV_APPS'] = 'books';
    // the boot with the flag
    expect(await syncInstalledModules(sql, ledgerEntries())).toEqual(['books']);
    expect((await call(owner, 'GET', '/settings/books')).json()).toEqual({ enabled: false, libraryId: null, folders: 0, works: 0, files: 0 });
    expect((await call(anna, 'GET', '/settings/books')).statusCode).toBe(403);
    expect((await call(anna, 'GET', '/books')).statusCode).toBe(409);
    expect((await call(anna, 'PUT', '/settings/books', { enabled: true })).statusCode).toBe(403);
    expect((await call(owner, 'PUT', '/settings/books', { on: true })).statusCode).toBe(400);

    const turnedOn = (await call(owner, 'PUT', '/settings/books', { enabled: true })).json();
    expect(turnedOn).toMatchObject({ enabled: true, folders: 0, works: 0, files: 0 });
    const libraryId = turnedOn.libraryId as string;
    expect(await sql`select name, app from libraries where id = ${libraryId}`).toEqual([{ name: 'Books', app: 'books' }]);
    // on again: the same library, not a second one
    expect((await call(owner, 'PUT', '/settings/books', { enabled: true })).json().libraryId).toBe(libraryId);
    expect((await call(anna, 'GET', '/facets')).json().apps).toEqual(['music', 'books']);
    const libs = (await call(anna, 'GET', '/libraries')).json().data;
    expect(libs.map((l: { name: string; app: string }) => `${l.name} ${l.app}`)).toEqual(['Music music', 'Books books']);

    // what books.group writes: a folder, two files, one work in two formats, one cover
    const rootId = randomUUID();
    await sql`insert into scan_roots (id, library_id, path, display_name, validation_status) values (${rootId}, ${libraryId}, '/mnt/books', 'Books', 'ok')`;
    const epub = randomUUID();
    const pdf = randomUUID();
    const gone = randomUUID();
    for (const [id, rel, handler, status] of [[epub, 'A/x.epub', 'epub', 'present'], [pdf, 'A/x.pdf', 'pdf', 'present'], [gone, 'B/y.epub', 'epub', 'missing']] as const) {
      await sql`insert into files (id, library_id, scan_root_id, rel_path, handler, status) values (${id}, ${libraryId}, ${rootId}, ${rel}, ${handler}, ${status})`;
    }
    const [w1] = await sql`insert into books_works (library_id, key, title, sort_title, series, series_index) values (${libraryId}, 'k1', 'A Test of Lanterns', 'test of lanterns', 'Lantern Tales', 1) returning id`;
    const [w2] = await sql`insert into books_works (library_id, key, title, sort_title) values (${libraryId}, 'k2', 'Only Missing', 'only missing') returning id`;
    const [a1] = await sql`insert into books_authors (library_id, name, name_key) values (${libraryId}, 'Ada Example', 'ada example') returning id`;
    const [a2] = await sql`insert into books_authors (library_id, name, name_key) values (${libraryId}, 'Eve Second', 'eve second') returning id`;
    await sql`insert into books_work_authors (work_id, author_id, position) values (${w1!['id']}, ${a2!['id']}, 1), (${w1!['id']}, ${a1!['id']}, 0)`;
    const jpeg = Buffer.from('ffd8ffe000104a464946', 'hex');
    const sha = createHash('sha256').update(jpeg).digest();
    const [e1] = await sql`insert into books_editions (file_id, work_id, format, title, cover_thumb, cover_sha256) values (${epub}, ${w1!['id']}, 'epub', 'A Test of Lanterns', ${jpeg}, ${sha}) returning id`;
    await sql`insert into books_editions (file_id, work_id, format, title) values (${pdf}, ${w1!['id']}, 'pdf', 'A Test of Lanterns')`;
    await sql`insert into books_editions (file_id, work_id, format, title) values (${gone}, ${w2!['id']}, 'epub', 'Only Missing')`;

    // a work whose only file is missing is not listed
    expect((await call(anna, 'GET', '/books')).json()).toEqual({
      works: [{ id: w1!['id'], title: 'A Test of Lanterns', authors: ['Ada Example', 'Eve Second'], series: 'Lantern Tales', seriesIndex: 1, formats: ['epub', 'pdf'], coverEditionId: e1!['id'] }],
    });
    const cover = await call(anna, 'GET', `/books/editions/${e1!['id']}/cover`);
    expect(cover.statusCode).toBe(200);
    expect(cover.headers['content-type']).toBe('image/jpeg');
    expect(cover.rawPayload).toEqual(jpeg);
    expect((await call(anna, 'GET', `/books/editions/${e1!['id']}/cover`, undefined, { 'if-none-match': cover.headers['etag'] as string })).statusCode).toBe(304);
    expect((await call(anna, 'GET', `/books/editions/${randomUUID()}/cover`)).statusCode).toBe(404);
    expect((await call(owner, 'GET', '/settings/books')).json()).toEqual({ enabled: true, libraryId, folders: 1, works: 2, files: 2 });

    // off: the routes refuse, every row stays
    expect((await call(owner, 'PUT', '/settings/books', { enabled: false })).json()).toMatchObject({ enabled: false, works: 2 });
    expect((await call(anna, 'GET', '/books')).statusCode).toBe(409);
    expect((await call(anna, 'GET', '/facets')).json().apps).toEqual(['music']);
    expect(await sql`select count(*)::int as n from books_editions`).toEqual([{ n: 3 }]);
  });

  it('a boot without the flag turns an app in development off, and leaves its data', async () => {
    process.env['TAGAVE_DEV_APPS'] = 'books';
    await setModuleEnabled(sql, 'books', true);
    const log: string[] = [];
    // with the flag nothing changes
    await turnOffDisallowedDevApps(sql, APPS, (app) => log.push(app));
    expect(await moduleEnabled(sql, 'books')).toBe(true);
    delete process.env['TAGAVE_DEV_APPS'];
    await turnOffDisallowedDevApps(sql, APPS, (app) => log.push(app));
    expect(await moduleEnabled(sql, 'books')).toBe(false);
    expect(log).toEqual(['books']);
    expect(await sql`select count(*)::int as n from books_editions`).toEqual([{ n: 3 }]);
    // the module ledger is unchanged otherwise: no module row is made for it
    expect(ledgerEntries(APPS, MODULES).map((e) => e.id)).not.toContain('books');
  });
});

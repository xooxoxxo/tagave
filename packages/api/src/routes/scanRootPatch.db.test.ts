/**
 * PATCH /libraries/:id/scan-roots/:rootId: a music folder's Rescan every
 * (poll_interval_s) can change after the folder is added, at least 60
 * seconds, saved with the folder's link in the folder's one Save.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import Fastify, { type FastifyInstance } from 'fastify';
import { createScratchDb, migrateAll } from '../testkit/authApp.js';

vi.mock('../boss.js', () => ({ getBoss: async () => ({ send: async () => 'job' }) }));

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('PATCH a scan root: Rescan every (integration)', () => {
  let admin: postgres.Sql;
  let raw: postgres.Sql;
  let client: postgres.Sql;
  let app: FastifyInstance;
  let dbName = '';
  const ownerId = randomUUID();
  const libraryId = randomUUID();
  const rootId = randomUUID();
  const owner = { 'x-test-user': ownerId, 'x-test-role': 'owner' };
  const patch = (payload: object) => app.inject({ method: 'PATCH', url: `/api/v1/libraries/${libraryId}/scan-roots/${rootId}`, headers: owner, payload });
  const stored = async () => (await raw<{ s: number }[]>`select poll_interval_s as s from scan_roots where id = ${rootId}`)[0]?.s;

  beforeAll(async () => {
    admin = postgres(url!, { max: 1, onnotice: () => undefined });
    const db = await createScratchDb(url!, admin);
    dbName = db.name;
    await migrateAll(db.url);
    raw = postgres(db.url, { max: 1, onnotice: () => undefined });
    const { initDb } = await import('../db.js');
    client = (await initDb(db.url)).client;
    await raw`insert into users (id, email, password_hash) values (${ownerId}, ${`o-${ownerId}@example.com`}, 'x')`;
    await raw`insert into libraries (id, owner_user_id, name, settings) values (${libraryId}, ${ownerId}, 'Home', '{}'::jsonb)`;
    await raw`insert into scan_roots (id, library_id, path, display_name, validation_status, poll_interval_s) values (${rootId}, ${libraryId}, '/music', 'Music', 'ok', 21600)`;

    const { errorHandler } = await import('../middleware/errorHandler.js');
    const { createLibraryRoutes } = await import('./library.js');
    app = Fastify({ logger: false });
    await errorHandler(app);
    app.addHook('preHandler', async (request) => {
      const id = request.headers['x-test-user'];
      request.user = typeof id === 'string' ? ({ id, email: `${id}@example.com`, role: request.headers['x-test-role'] } as any) : undefined;
    });
    await app.register(createLibraryRoutes, { prefix: '/api/v1/libraries' });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await raw?.end({ timeout: 2 });
    await client?.end({ timeout: 2 });
    if (dbName) await admin.unsafe(`drop database if exists ${dbName} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
  });

  it('changes Rescan every and answers with it', async () => {
    const res = await patch({ pollIntervalS: 3600 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().pollIntervalS).toBe(3600);
    expect(await stored()).toBe(3600);
  });

  it('takes 60 seconds, the shortest', async () => {
    expect((await patch({ pollIntervalS: 60 })).statusCode).toBe(200);
    expect(await stored()).toBe(60);
  });

  it('refuses less than 60 seconds and keeps the stored value', async () => {
    await patch({ pollIntervalS: 600 });
    for (const pollIntervalS of [59, 1, 0, -60, 90.5]) {
      const res = await patch({ pollIntervalS });
      expect(res.statusCode, `${pollIntervalS}: ${res.body}`).toBe(400);
    }
    expect(await stored()).toBe(600);
  });

  it('saves with the folder link in one request', async () => {
    const res = await patch({ pollIntervalS: 7200, folderLink: 'smb://nas.example.com/music/' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ pollIntervalS: 7200, folderLink: 'smb://nas.example.com/music/' });
    expect(await stored()).toBe(7200);
    // clearing the link leaves the interval
    const cleared = await patch({ pollIntervalS: 7200, folderLink: null });
    expect(cleared.json()).toMatchObject({ pollIntervalS: 7200, folderLink: null });
  });
});

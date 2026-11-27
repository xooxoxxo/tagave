/**
 * Player scans wait while a music folder is offline or not connected (the
 * worker sends them once the folder's return scan ends). A folder that is
 * turned off or removed instead never returns: once no enabled folder is
 * still not online, the waiting requests are sent from here.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import Fastify, { type FastifyInstance } from 'fastify';
import { createScratchDb, migrateAll } from '../testkit/authApp.js';

const boss = vi.hoisted(() => ({ send: vi.fn(async () => 'job') }));
vi.mock('../boss.js', () => ({ getBoss: async () => ({ send: boss.send, createQueue: async () => undefined }) }));

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('a music folder turned off or removed sends the waiting player scans (integration)', () => {
  let admin: postgres.Sql;
  let raw: postgres.Sql;
  let client: postgres.Sql;
  let app: FastifyInstance;
  let dbName = '';
  const ownerId = randomUUID();
  const libraryId = randomUUID();
  const owner = { 'x-test-user': ownerId, 'x-test-role': 'owner' };
  const playerSends = () => boss.send.mock.calls.filter((c) => (c as unknown[])[0] === 'player.scan');
  const root = async (reach: string) => {
    const id = randomUUID();
    await raw`insert into scan_roots (id, library_id, path, display_name, validation_status, reach, reach_since)
              values (${id}, ${libraryId}, ${`/mnt/music/${id}`}, 'Music', 'ok', ${reach}, now())`;
    return id;
  };
  const off = (id: string) => app.inject({ method: 'PATCH', url: `/api/v1/libraries/${libraryId}/scan-roots/${id}`, headers: owner, payload: { enabled: false } });
  const remove = (id: string) => app.inject({ method: 'DELETE', url: `/api/v1/libraries/${libraryId}/scan-roots/${id}`, headers: owner });

  beforeAll(async () => {
    admin = postgres(url!, { max: 1, onnotice: () => undefined });
    const db = await createScratchDb(url!, admin);
    dbName = db.name;
    await migrateAll(db.url);
    raw = postgres(db.url, { max: 1, onnotice: () => undefined });
    const { initDb } = await import('../db.js');
    client = (await initDb(db.url)).client;
    await raw`insert into users (id, email, password_hash) values (${ownerId}, ${'robin@example.com'}, 'x')`;
    await raw`insert into libraries (id, owner_user_id, name, settings) values (${libraryId}, ${ownerId}, 'Home', '{}'::jsonb)`;

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

  beforeEach(async () => {
    boss.send.mockClear();
    await raw`delete from scan_roots where library_id = ${libraryId}`;
    await raw`delete from player_scan_requests where library_id = ${libraryId}`;
    await raw`insert into player_scan_requests (library_id, folder) values (${libraryId}, 'A/One')`;
  });

  afterAll(async () => {
    await app?.close();
    await raw?.end({ timeout: 2 });
    await client?.end({ timeout: 2 });
    if (dbName) await admin.unsafe(`drop database if exists ${dbName} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
  });

  it('the offline folder turned off: the waiting scan goes', async () => {
    const offline = await root('offline');
    await root('online');
    expect((await off(offline)).statusCode).toBe(200);
    expect(playerSends()).toEqual([['player.scan', { libraryId }, expect.objectContaining({ singletonKey: `player.scan:${libraryId}` })]]);
  });

  it('the folder not connected removed: the waiting scan goes', async () => {
    const unmounted = await root('unmounted');
    expect((await remove(unmounted)).statusCode).toBe(204);
    expect(playerSends()).toHaveLength(1);
  });

  it('another enabled folder still offline: nothing goes, the request keeps waiting', async () => {
    const offline = await root('offline');
    await root('unmounted');
    expect((await off(offline)).statusCode).toBe(200);
    expect(playerSends()).toHaveLength(0);
    expect(await raw`select folder from player_scan_requests where library_id = ${libraryId}`).toEqual([{ folder: 'A/One' }]);
  });
});

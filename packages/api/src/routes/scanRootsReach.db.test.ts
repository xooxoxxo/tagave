/**
 * GET /libraries/:id/scan-roots (Settings › Library): each music folder
 * carries what the folder watch last saw (reach, since when) and how much
 * work waits for it to come back (vault "tagave - Offline Library Spec" §5).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import Fastify, { type FastifyInstance } from 'fastify';
import { createScratchDb, migrateAll } from '../testkit/authApp.js';

vi.mock('../boss.js', () => ({ getBoss: async () => ({ send: async () => 'job' }) }));

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('GET scan roots: reach and waiting (integration)', () => {
  let admin: postgres.Sql;
  let raw: postgres.Sql;
  let client: postgres.Sql;
  let app: FastifyInstance;
  let dbName = '';
  const ownerId = randomUUID();
  const libraryId = randomUUID();
  const offlineRoot = randomUUID();
  const newRoot = randomUUID();
  const owner = { 'x-test-user': ownerId, 'x-test-role': 'owner' };

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
    await raw`insert into scan_roots (id, library_id, path, display_name, validation_status, reach, reach_since, reach_reason)
      values (${offlineRoot}, ${libraryId}, '/mnt/music', 'Music', 'ok', 'offline', '2026-11-24T14:02:00Z', 'server_silent')`;
    await raw`insert into scan_roots (id, library_id, path, display_name, validation_status) values (${newRoot}, ${libraryId}, '/mnt/more', 'More', 'ok')`;
    const park = (queue: string, key: string | null) =>
      raw`insert into parked_jobs (scan_root_id, queue, data, singleton_key, reason) values (${offlineRoot}, ${queue}, '{}', ${key}, 'offline')`;
    await park('scan.root', `scan:${offlineRoot}`);
    await park('tags.apply', 'tags.apply:p1');
    await park('fingerprint.album', null);

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

  it('Settings › Library lists reach and waiting per root', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/libraries/${libraryId}/scan-roots`, headers: owner });
    expect(res.statusCode, res.body).toBe(200);
    const byId = new Map((res.json().data as Array<{ id: string }>).map((r) => [r.id, r]));
    expect(byId.get(offlineRoot)).toMatchObject({ reach: 'offline', reachSince: '2026-11-24T14:02:00.000Z', waiting: { scans: 1, tagWrites: 1, other: 1 } });
    expect(byId.get(newRoot)).toMatchObject({ reach: 'unknown', reachSince: null, waiting: { scans: 0, tagWrites: 0, other: 0 } });
  });
});

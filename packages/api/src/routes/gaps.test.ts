/**
 * The three gap choices and the Tasks list against a real database (0032):
 * accept → todo with a note, dismiss as not a problem or wrong, reopen, and
 * the list of open and recently done tasks with the words a task needs.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { gaps, libraries, localAlbums, users } from '@liner/db';
import type { GapTasksResponse } from '@liner/shared';

const boss = vi.hoisted(() => ({
  createQueue: vi.fn(async () => undefined),
  send: vi.fn(async (): Promise<string | null> => 'boss-job-1'),
}));
vi.mock('../boss.js', () => ({ getBoss: async () => boss }));

describe.skipIf(!process.env.TEST_DATABASE_URL)('gap choices and tasks (db)', () => {
  let app: FastifyInstance;
  let db: ReturnType<typeof import('../db.js')['getDb']>;
  let client: { end: () => Promise<void> };
  const userId = randomUUID();
  const strangerId = randomUUID();
  const libraryId = randomUUID();
  const strangerLibraryId = randomUUID();
  const albumId = randomUUID();
  const ids = { incomplete: randomUUID(), cover: randomUUID(), bitrate: randomUUID(), done: randomUUID(), old: randomUUID(), gone: randomUUID(), stranger: randomUUID() };
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
  const gap = async (id: string) => (await db.select().from(gaps).where(eq(gaps.id, id)))[0]!;

  beforeAll(async () => {
    const dbUrl = process.env.TEST_DATABASE_URL;
    if (!dbUrl) throw new Error('TEST_DATABASE_URL not set — these suites delete rows and must never run against DATABASE_URL');
    const { initDb, getDb } = await import('../db.js');
    const conn = await initDb(dbUrl);
    client = conn.client;
    db = getDb();
    await db.insert(users).values([
      { id: userId, email: `gaps-${userId}@test.com`, passwordHash: 'x' },
      { id: strangerId, email: `gaps-${strangerId}@test.com`, passwordHash: 'x' },
    ]);
    await db.insert(libraries).values([
      { id: libraryId, name: 'Gaps test', ownerUserId: userId },
      { id: strangerLibraryId, name: 'Not mine', ownerUserId: strangerId },
    ]);
    await db.insert(localAlbums).values({
      id: albumId, libraryId, clusterKey: `gaps-${albumId}`, dirPaths: ['Karunesh/Transformation'],
      titleGuess: 'Transformation', artistGuess: 'Karunesh', state: 'matched',
    });
    const missing = [{ disc: 1, position: 1, title: 'Sound of Soul' }, { disc: 1, position: 2, title: 'Change' }];
    await db.insert(gaps).values([
      { id: ids.incomplete, libraryId, kind: 'incomplete_album', subjectType: 'local_album', subjectId: albumId, details: { have: 16, want: 18, missing } },
      { id: ids.cover, libraryId, kind: 'quality', subjectType: 'local_album', subjectId: albumId, flag: 'noCover', details: { flags: { noCover: true } } },
      { id: ids.bitrate, libraryId, kind: 'quality', subjectType: 'local_album', subjectId: albumId, flag: 'lowBitrate', details: { flags: { lowBitrate: 3 } } },
      { id: ids.done, libraryId, kind: 'quality', subjectType: 'local_album', subjectId: albumId, flag: 'parseErrors', details: { flags: { parseErrors: 1 } },
        state: 'resolved', acceptedAt: daysAgo(5), resolvedAt: daysAgo(1) },
      { id: ids.old, libraryId, kind: 'quality', subjectType: 'local_album', subjectId: albumId, flag: 'mixedLossless', details: { flags: { mixedLossless: true } },
        state: 'resolved', acceptedAt: daysAgo(90), resolvedAt: daysAgo(60) },
      { id: ids.gone, libraryId, kind: 'incomplete_album', subjectType: 'local_album', subjectId: randomUUID(), details: { have: 1, want: 2 },
        state: 'todo', acceptedAt: daysAgo(2) },
      { id: ids.stranger, libraryId: strangerLibraryId, kind: 'duplicate', subjectType: 'release_group', subjectId: randomUUID(), details: { count: 2 } },
    ]);

    const { errorHandler } = await import('../middleware/errorHandler.js');
    const { createGapRoutes } = await import('./gaps.js');
    app = Fastify();
    await errorHandler(app);
    app.addHook('preHandler', async (request) => {
      request.user = { id: userId, email: 'owner@test.com', displayName: 'Owner', role: 'owner', createdAt: new Date().toISOString() };
    });
    await app.register(createGapRoutes, { prefix: '/api/v1' });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (!db) return;
    await db.delete(libraries).where(eq(libraries.ownerUserId, userId)); // cascades gaps and albums
    await db.delete(libraries).where(eq(libraries.ownerUserId, strangerId));
    await db.delete(users).where(eq(users.id, userId));
    await db.delete(users).where(eq(users.id, strangerId));
    await client.end();
  });

  it('adds a gap to the task list with a note', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/gaps/${ids.incomplete}/accept`, payload: { note: '  ask Deniz for the CD  ' } });
    expect(res.statusCode).toBe(200);
    const row = await gap(ids.incomplete);
    expect(row.state).toBe('todo');
    expect(row.acceptedAt).not.toBeNull();
    expect(row.decidedAt).not.toBeNull();
    expect(row.note).toBe('ask Deniz for the CD');
  });

  it('hides one quality flag without touching the album’s other flags', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/gaps/${ids.bitrate}/dismiss`, payload: { reason: 'not_interested' } });
    expect(res.statusCode).toBe(200);
    expect((await gap(ids.bitrate)).state).toBe('dismissed');
    expect((await gap(ids.cover)).state).toBe('open');
  });

  it('records "this is wrong" and takes a task off the list when it is dismissed', async () => {
    await app.inject({ method: 'POST', url: `/api/v1/gaps/${ids.cover}/accept`, payload: {} });
    const res = await app.inject({ method: 'POST', url: `/api/v1/gaps/${ids.cover}/dismiss`, payload: { reason: 'wrong_data' } });
    expect(res.statusCode).toBe(200);
    const row = await gap(ids.cover);
    expect(row).toMatchObject({ state: 'dismissed', dismissReason: 'wrong_data', acceptedAt: null });
  });

  it('refuses an unknown reason and a stranger’s gap', async () => {
    expect((await app.inject({ method: 'POST', url: `/api/v1/gaps/${ids.cover}/dismiss`, payload: { reason: 'meh' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/v1/gaps/${ids.stranger}/accept`, payload: {} })).statusCode).toBe(404);
  });

  it('refuses to accept or reopen a gap a scan already resolved', async () => {
    expect((await app.inject({ method: 'POST', url: `/api/v1/gaps/${ids.done}/accept`, payload: {} })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/api/v1/gaps/${ids.done}/reopen` })).statusCode).toBe(409);
  });

  it('lists open tasks and the recently done ones, with what the task sentence needs', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/libraries/${libraryId}/tasks` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as GapTasksResponse;
    expect(body.todo.map((t) => t.id).sort()).toEqual([ids.incomplete, ids.gone].sort());
    const task = body.todo.find((t) => t.id === ids.incomplete)!;
    expect(task).toMatchObject({
      kind: 'incomplete_album', state: 'todo', albumId, title: 'Transformation', artist: 'Karunesh',
      folder: 'Karunesh/Transformation', note: 'ask Deniz for the CD', subjectGone: false, resolvedAt: null,
    });
    expect(body.todo.find((t) => t.id === ids.gone)!.subjectGone).toBe(true);
    // done in the last 30 days only
    expect(body.done.map((t) => t.id)).toEqual([ids.done]);
    expect(body.done[0]!.resolvedAt).not.toBeNull();
  });

  it('counts tasks next to the open gaps', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/libraries/${libraryId}/gaps?limit=1` });
    const body = res.json() as { counts: Record<string, number>; tasks: { todo: number; done: number } };
    expect(body.tasks).toEqual({ todo: 2, done: 1 });
    expect(body.counts['incomplete_album']).toBeUndefined(); // the task is not "open" any more
  });

  it('edits a note, and reopening clears the decision', async () => {
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/gaps/${ids.incomplete}`, payload: { note: 'found it on Bandcamp' } })).statusCode).toBe(200);
    expect((await gap(ids.incomplete)).note).toBe('found it on Bandcamp');
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/gaps/${ids.incomplete}`, payload: { note: 'x'.repeat(501) } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/v1/gaps/${ids.incomplete}/reopen` })).statusCode).toBe(200);
    expect(await gap(ids.incomplete)).toMatchObject({ state: 'open', acceptedAt: null, note: null, dismissReason: null });
  });

  it('queues a gap check on request', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/libraries/${libraryId}/gaps/recompute`, payload: {} });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ queued: true });
    expect(boss.send).toHaveBeenCalledWith('gaps.recompute', { libraryId }, { singletonKey: `gaps:${libraryId}` });
  });
});

/**
 * POST /libraries/:libraryId/jobs/:jobId/retry against a real database, with
 * pg-boss replaced: what it refuses (and why), what it enqueues, and the
 * "created" row it leaves so the page shows the retry as waiting.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { jobRuns, libraries, scanRoots, users } from '@liner/db';

const boss = vi.hoisted(() => ({
  createQueue: vi.fn(async () => undefined),
  send: vi.fn(async (): Promise<string | null> => 'boss-job-1'),
}));
vi.mock('../boss.js', () => ({ getBoss: async () => boss }));

describe.skipIf(!process.env.TEST_DATABASE_URL)('POST .../jobs/:jobId/retry (db)', () => {
  let app: FastifyInstance;
  let db: ReturnType<typeof import('../db.js')['getDb']>;
  let client: { end: () => Promise<void> };
  const userId = randomUUID();
  const strangerId = randomUUID();
  const libraryId = randomUUID();
  const strangerLibraryId = randomUUID();
  const okRoot = randomUUID();
  const badRoot = randomUUID();
  const ago = (hours: number) => new Date(Date.now() - hours * 3600_000);
  const ids = {
    scanFailed: randomUUID(), badRootFailed: randomUUID(), gapsDone: randomUUID(),
    enrichFailed: randomUUID(), enrichDone: randomUUID(),
    syncOld: randomUUID(), syncNew: randomUUID(), dirFailed: randomUUID(), strangerFailed: randomUUID(), goneRootFailed: randomUUID(),
  };
  const url = (jobId: string, lib = libraryId) => `/api/v1/libraries/${lib}/jobs/${jobId}/retry`;

  beforeAll(async () => {
    const dbUrl = process.env.TEST_DATABASE_URL;
    if (!dbUrl) throw new Error('TEST_DATABASE_URL not set — these suites delete rows and must never run against DATABASE_URL');
    const { initDb, getDb } = await import('../db.js');
    const conn = await initDb(dbUrl);
    client = conn.client;
    db = getDb();
    await db.insert(users).values([
      { id: userId, email: `retry-${userId}@test.com`, passwordHash: 'x' },
      { id: strangerId, email: `retry-${strangerId}@test.com`, passwordHash: 'x' },
    ]);
    await db.insert(libraries).values([
      { id: libraryId, name: 'Retry test', ownerUserId: userId },
      { id: strangerLibraryId, name: 'Not mine', ownerUserId: strangerId },
    ]);
    await db.insert(scanRoots).values([
      { id: okRoot, libraryId, path: '/music', displayName: 'Music', validationStatus: 'ok' },
      { id: badRoot, libraryId, path: '/gone', displayName: 'Gone', validationStatus: 'unreadable' },
    ]);
    const lib = { libraryId };
    const sync = { ...lib, type: 'collection.sync' };
    const enrich = { ...lib, type: 'enrich.sweep' };
    await db.insert(jobRuns).values([
      { ...lib, id: ids.scanFailed, type: 'scan.root', subjectType: 'scan_root', subjectId: okRoot, state: 'failed',
        error: 'walk failed: EIO', startedAt: ago(5), finishedAt: ago(4), createdAt: ago(5) },
      { ...lib, id: ids.badRootFailed, type: 'scan.root', subjectType: 'scan_root', subjectId: badRoot, state: 'failed',
        error: 'ENOENT', startedAt: ago(5), finishedAt: ago(5), createdAt: ago(5) },
      { ...lib, id: ids.gapsDone, type: 'gaps.recompute', state: 'completed', startedAt: ago(2), finishedAt: ago(2), createdAt: ago(2) },
      { ...enrich, id: ids.enrichDone, state: 'completed', startedAt: ago(1), finishedAt: ago(1), createdAt: ago(1) },
      { ...enrich, id: ids.enrichFailed, state: 'failed', error: 'x', startedAt: ago(3), finishedAt: ago(3), createdAt: ago(3) },
      { ...sync, id: ids.syncNew, state: 'failed', error: 'token rejected', startedAt: ago(2), finishedAt: ago(2), createdAt: ago(2) },
      { ...sync, id: ids.syncOld, state: 'failed', error: 'token rejected', startedAt: ago(6), finishedAt: ago(6), createdAt: ago(6) },
      { ...lib, id: ids.dirFailed, type: 'scan.dir', subjectType: 'scan_root', subjectId: okRoot, state: 'failed',
        error: 'EACCES', startedAt: ago(1), finishedAt: ago(1), createdAt: ago(1) },
      { ...lib, id: ids.goneRootFailed, type: 'scan.root', subjectType: 'scan_root', subjectId: randomUUID(), state: 'failed',
        error: 'ENOENT', startedAt: ago(7), finishedAt: ago(7), createdAt: ago(7) },
      { id: ids.strangerFailed, libraryId: strangerLibraryId, type: 'collection.sync', state: 'failed', error: 'no', createdAt: ago(1) },
    ]);

    const { errorHandler } = await import('../middleware/errorHandler.js');
    const { createJobRoutes } = await import('./jobs.js');
    app = Fastify();
    await errorHandler(app);
    app.addHook('preHandler', async (request) => {
      request.user = { id: userId, email: 'owner@test.com', displayName: 'Owner', role: 'owner', createdAt: new Date().toISOString() };
    });
    await app.register(createJobRoutes, { prefix: '/api/v1' });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (!db) return;
    await db.delete(libraries).where(eq(libraries.ownerUserId, userId)); // cascades job_runs, scan_roots
    await db.delete(libraries).where(eq(libraries.ownerUserId, strangerId));
    await db.delete(users).where(eq(users.id, userId));
    await db.delete(users).where(eq(users.id, strangerId));
    await client.end();
  });

  beforeEach(() => {
    boss.send.mockClear();
    boss.createQueue.mockClear();
  });

  it('lists every task that needs the owner apart from the paged entries', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/libraries/${libraryId}/jobs?limit=1&include=routine` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as import('@liner/shared').JobsListResponse;
    const attention = body.attention.map((v) => v.id).sort();
    expect(attention).toEqual([ids.scanFailed, ids.badRootFailed, ids.goneRootFailed, ids.syncNew, ids.dirFailed].sort());
    expect(body.summary.needsAttention).toBe(5);
    expect(body.data).toHaveLength(1);
    expect(body.data.some((v) => v.needsAttention)).toBe(false);
    expect(body.pagination.total).toBe(4); // the two finished checks, the fixed failure and the repeated one
  });

  it('restarts a failed folder scan as a full scan and records it as waiting', async () => {
    const res = await app.inject({ method: 'POST', url: url(ids.scanFailed) });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { queued: boolean; jobId: string | null };
    expect(body.queued).toBe(true);
    expect(boss.send).toHaveBeenCalledWith('scan.root', { scanRootId: okRoot, mode: 'full' }, { singletonKey: `scan:${okRoot}` });
    const [inserted] = await db.select().from(jobRuns).where(and(eq(jobRuns.id, body.jobId!), eq(jobRuns.libraryId, libraryId)));
    expect(inserted).toMatchObject({ type: 'scan.root', subjectId: okRoot, state: 'created', pgbossId: 'boss-job-1' });

    // pressed again: the retry is already waiting
    const again = await app.inject({ method: 'POST', url: url(ids.scanFailed) });
    expect(again.statusCode).toBe(409);
    expect(again.json().detail).toBe('This work is already running again.');
  });

  it('reports queued: false and inserts nothing when pg-boss already has the job', async () => {
    boss.send.mockResolvedValueOnce(null);
    const res = await app.inject({ method: 'POST', url: url(ids.syncNew) });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ queued: false, jobId: null });
  });

  it('refuses a task that did not fail', async () => {
    const res = await app.inject({ method: 'POST', url: url(ids.gapsDone) });
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toBe('This task did not fail, so there is nothing to retry.');
    expect(boss.send).not.toHaveBeenCalled();
  });

  it('refuses a failure a later run already fixed', async () => {
    const res = await app.inject({ method: 'POST', url: url(ids.enrichFailed) });
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toBe('A later run already finished this work.');
  });

  it('refuses an older failure that a newer attempt repeated', async () => {
    const res = await app.inject({ method: 'POST', url: url(ids.syncOld) });
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toBe('This work was tried again later; retry the newer attempt instead.');
    expect(boss.send).not.toHaveBeenCalled();
  });

  it('refuses to scan a music folder the app cannot read', async () => {
    const res = await app.inject({ method: 'POST', url: url(ids.badRootFailed) });
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toMatch(/cannot read this music folder/);
    expect(boss.send).not.toHaveBeenCalled();
  });

  it('refuses to scan a music folder that has been removed', async () => {
    const res = await app.inject({ method: 'POST', url: url(ids.goneRootFailed) });
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toBe('This music folder has been removed.');
    expect(boss.send).not.toHaveBeenCalled();
  });

  it('refuses a folder rescan, which it cannot rebuild', async () => {
    const res = await app.inject({ method: 'POST', url: url(ids.dirFailed) });
    expect(res.statusCode).toBe(400);
    expect(boss.send).not.toHaveBeenCalled();
  });

  it("does not find another library's job, or a library that is not yours", async () => {
    expect((await app.inject({ method: 'POST', url: url(ids.strangerFailed) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: url(ids.strangerFailed, strangerLibraryId) })).statusCode).toBe(404);
    expect(boss.send).not.toHaveBeenCalled();
  });
});

/**
 * One Scan press while the music folder is offline is one Jobs entry (vault
 * "tagave - Offline Library Spec" §7, Jobs page: Waiting, "Music folder
 * offline"). The worker opens a job run and marks it cancelled with the
 * offline-skip text, and parks the job; the list shows only the parked row.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { jobRuns, libraries, scanRoots, users } from '@tagave/db';
import { SCAN_OFFLINE_SKIP, type JobsListResponse } from '@tagave/shared';

// Retry enqueues through pg-boss: stood in, as in jobsRetry.test.ts
vi.mock('../boss.js', () => ({ getBoss: async () => ({ createQueue: async () => undefined, send: async () => 'boss-job-1' }) }));

describe.skipIf(!process.env.TEST_DATABASE_URL)('GET .../jobs while a music folder is offline (db)', () => {
  let app: FastifyInstance;
  let db: ReturnType<typeof import('../db.js')['getDb']>;
  let client: { end: () => Promise<void> } & ((...a: any[]) => any);
  const userId = randomUUID();
  const libraryId = randomUUID();
  const rootId = randomUUID();
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
  const ids = { scanSkipped: randomUUID(), dirSkipped: randomUUID(), scanCancelled: randomUUID() };
  let parkedScan = '';
  let parkedDir = '';

  beforeAll(async () => {
    const dbUrl = process.env.TEST_DATABASE_URL;
    if (!dbUrl) throw new Error('TEST_DATABASE_URL not set');
    const { initDb, getDb } = await import('../db.js');
    const conn = await initDb(dbUrl);
    client = conn.client as typeof client;
    db = getDb();
    await db.insert(users).values({ id: userId, email: `robin-${userId}@example.com`, passwordHash: 'x' });
    await db.insert(libraries).values({ id: libraryId, name: 'Offline jobs', ownerUserId: userId });
    await db.insert(scanRoots).values({ id: rootId, libraryId, path: `/mnt/music/jobs-${libraryId}`, displayName: 'Music', validationStatus: 'ok' });
    const scan = { libraryId, subjectType: 'scan_root', subjectId: rootId, state: 'cancelled' };
    await db.insert(jobRuns).values([
      { ...scan, id: ids.scanSkipped, type: 'scan.root', error: SCAN_OFFLINE_SKIP, startedAt: ago(5), finishedAt: ago(5), createdAt: ago(5) },
      { ...scan, id: ids.dirSkipped, type: 'scan.dir', error: SCAN_OFFLINE_SKIP, startedAt: ago(4), finishedAt: ago(4), createdAt: ago(4) },
      // the owner's own Cancel stays on the list
      { ...scan, id: ids.scanCancelled, type: 'scan.root', error: null, startedAt: ago(60), finishedAt: ago(59), createdAt: ago(60) },
    ]);
    const [s] = await client`insert into parked_jobs (scan_root_id, queue, data, singleton_key, reason)
      values (${rootId}, 'scan.root', ${JSON.stringify({ scanRootId: rootId })}::text::jsonb, ${`scan:${rootId}`}, 'timeout') returning id::text as id`;
    const [d] = await client`insert into parked_jobs (scan_root_id, queue, data, singleton_key, reason)
      values (${rootId}, 'scan.dir', ${JSON.stringify({ scanRootId: rootId, dirPath: 'Robin' })}::text::jsonb, ${`scan.dir:${rootId}:Robin`}, 'timeout') returning id::text as id`;
    parkedScan = s.id;
    parkedDir = d.id;

    const { errorHandler } = await import('../middleware/errorHandler.js');
    const { createJobRoutes } = await import('./jobs.js');
    app = Fastify();
    await errorHandler(app);
    app.addHook('preHandler', async (request) => {
      request.user = { id: userId, email: 'robin@example.com', displayName: 'Robin', role: 'owner', createdAt: new Date().toISOString() };
    });
    await app.register(createJobRoutes, { prefix: '/api/v1' });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (!db) return;
    await client`delete from parked_jobs where scan_root_id = ${rootId}`;
    await db.delete(libraries).where(eq(libraries.ownerUserId, userId)); // cascades job_runs, scan_roots
    await db.delete(users).where(eq(users.id, userId));
    await client.end();
  });

  it('shows the parked Waiting row and leaves out the run the worker cut off for the offline folder', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/libraries/${libraryId}/jobs?include=routine` });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as JobsListResponse;
    const all = [...body.attention, ...body.data];
    const ids_ = all.map((v) => v.id);
    expect(ids_).not.toContain(ids.scanSkipped);
    expect(ids_).not.toContain(ids.dirSkipped);
    const scans = all.filter((v) => v.label === 'Scan Music');
    expect(scans.map((v) => v.id).sort()).toEqual([parkedScan, ids.scanCancelled].sort());
    expect(all.find((v) => v.id === parkedScan)).toMatchObject({ status: 'waiting', summary: 'Music folder offline' });
    expect(all.find((v) => v.id === parkedDir)).toMatchObject({ status: 'waiting', summary: 'Music folder offline' });
    expect(all.find((v) => v.id === ids.scanCancelled)).toMatchObject({ status: 'cancelled' });
  });

  it('a deep link to the cut-off run does not bring it back', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/libraries/${libraryId}/jobs?job=${ids.scanSkipped}` });
    const body = res.json() as JobsListResponse;
    expect([...body.attention, ...body.data].map((v) => v.id)).not.toContain(ids.scanSkipped);
  });

  it('a failed scan stays retryable after a cut-off run: the retry route ignores the hidden run as the list does', async () => {
    const failed = randomUUID();
    const cutOff = randomUUID();
    const scan = { libraryId, type: 'scan.root', subjectType: 'scan_root', subjectId: rootId };
    await db.insert(jobRuns).values([
      { ...scan, id: failed, state: 'failed', error: 'walk failed: EIO', startedAt: ago(30), finishedAt: ago(29), createdAt: ago(30) },
      { ...scan, id: cutOff, state: 'cancelled', error: SCAN_OFFLINE_SKIP, startedAt: ago(1), finishedAt: ago(1), createdAt: ago(1) },
    ]);
    const made: string[] = [failed, cutOff];
    try {
      const list = (await app.inject({ method: 'GET', url: `/api/v1/libraries/${libraryId}/jobs` })).json() as JobsListResponse;
      expect(list.attention.find((v) => v.id === failed)).toMatchObject({ status: 'failed', retryable: true, resolvedAt: null, retrying: false });
      const one = await app.inject({ method: 'GET', url: `/api/v1/libraries/${libraryId}/jobs/${failed}` });
      expect(one.json()).toMatchObject({ status: 'failed', retryable: true, needsAttention: true });
      const res = await app.inject({ method: 'POST', url: `/api/v1/libraries/${libraryId}/jobs/${failed}/retry` });
      expect(res.statusCode, res.body).toBe(202);
      const jobId = (res.json() as { jobId?: string }).jobId;
      if (jobId) made.push(jobId);
    } finally {
      await db.delete(jobRuns).where(inArray(jobRuns.id, made));
    }
  });
});

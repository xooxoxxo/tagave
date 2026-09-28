/**
 * The activity page's loader against a real database: heartbeats never come
 * back, scan jobs carry their folder's name, other libraries stay out, and a
 * deep-linked job older than the window is still found.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { jobRuns, libraries, scanRoots, users, makeDb } from '@liner/db';
import type { JobView } from '@liner/shared';
import { loadJobRows } from './jobs.js';
import { deriveJobViews, summarizeJobs } from '../lib/jobView.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('loadJobRows (db)', () => {
  let conn: Awaited<ReturnType<typeof makeDb>>;
  const userId = randomUUID();
  const libraryId = randomUUID();
  const otherLibraryId = randomUUID();
  const rootId = randomUUID();
  const ago = (hours: number) => new Date(Date.now() - hours * 3600_000);
  const ids = {
    heartbeat: randomUUID(), scanDone: randomUUID(), scanFailed: randomUUID(), syncFailed: randomUUID(),
    enrich: randomUUID(), ancient: randomUUID(), foreign: randomUUID(),
  };

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('TEST_DATABASE_URL not set — these suites delete rows and must never run against DATABASE_URL');
    conn = await makeDb(url);
    const { db } = conn;
    await db.insert(users).values({ id: userId, email: `jobs-${userId}@test.com`, passwordHash: 'x' });
    await db.insert(libraries).values([
      { id: libraryId, name: 'Jobs test', ownerUserId: userId },
      { id: otherLibraryId, name: 'Other', ownerUserId: userId },
    ]);
    await db.insert(scanRoots).values({ id: rootId, libraryId, path: '/music', displayName: 'Music', validationStatus: 'ok' });
    await db.insert(jobRuns).values([
      { id: ids.heartbeat, libraryId, type: 'worker.heartbeat', state: 'completed', progress: { workerId: 'w' }, createdAt: ago(0.01) },
      { id: ids.scanDone, libraryId, type: 'scan.root', subjectType: 'scan_root', subjectId: rootId, state: 'completed',
        progress: { done: 12, total: 12, message: 'quick: 12 seen, 1 added, 0 changed, 0 missing, 3/4 dirs skipped, 2s' },
        startedAt: ago(1), finishedAt: ago(0.9), createdAt: ago(1) },
      { id: ids.scanFailed, libraryId, type: 'scan.root', subjectType: 'scan_root', subjectId: rootId, state: 'failed',
        error: 'walk failed: EIO', startedAt: ago(5), finishedAt: ago(4), createdAt: ago(5) },
      { id: ids.syncFailed, libraryId, type: 'collection.sync', state: 'failed', error: 'Discogs token rejected',
        startedAt: ago(3), finishedAt: ago(3), createdAt: ago(3) },
      { id: ids.enrich, libraryId, type: 'enrich.sweep', state: 'completed',
        progress: { done: 0, total: 0, message: 'enqueued 0 releases for Discogs bridging' }, startedAt: ago(2), createdAt: ago(2) },
      { id: ids.ancient, libraryId, type: 'scan.root', subjectType: 'scan_root', subjectId: rootId, state: 'completed',
        startedAt: ago(24 * 60), finishedAt: ago(24 * 60), createdAt: ago(24 * 60) },
      { id: ids.foreign, libraryId: otherLibraryId, type: 'scan.root', state: 'failed', error: 'not mine', createdAt: ago(1) },
    ]);
  });

  afterAll(async () => {
    if (!conn) return;
    await conn.db.delete(libraries).where(eq(libraries.ownerUserId, userId)); // cascades job_runs, scan_roots
    await conn.db.delete(users).where(eq(users.id, userId));
    await conn.client.end();
  });

  it('leaves heartbeats, other libraries and rows outside the window out', async () => {
    const rows = await loadJobRows(conn.db, libraryId);
    const got = rows.map((r) => r.id);
    expect(got).toEqual([ids.scanDone, ids.enrich, ids.syncFailed, ids.scanFailed]); // newest first
    expect(rows[0]!.subjectName).toBe('Music');
  });

  it('adds a deep-linked job from before the window, and ignores ids that are not uuids', async () => {
    const rows = await loadJobRows(conn.db, libraryId, ids.ancient);
    expect(rows.at(-1)!.id).toBe(ids.ancient);
    expect(await loadJobRows(conn.db, libraryId, 'nope')).toHaveLength(4);
    expect((await loadJobRows(conn.db, libraryId, ids.foreign)).some((r) => r.id === ids.foreign)).toBe(false);
  });

  it('derives what the page shows from those rows', async () => {
    const views = deriveJobViews(await loadJobRows(conn.db, libraryId), libraryId)
      .filter((v): v is JobView => v !== null);
    const byId = new Map(views.map((v) => [v.id, v]));
    expect(byId.get(ids.scanDone)).toMatchObject({ label: 'Scan Music', status: 'done', summary: 'Checked 12 files: 1 added.' });
    expect(byId.get(ids.scanFailed)).toMatchObject({ status: 'failed', resolvedAt: expect.any(String), retryable: false });
    expect(byId.get(ids.syncFailed)).toMatchObject({ status: 'failed', error: 'Discogs token rejected', retryable: true, resolvedAt: null });
    expect(byId.get(ids.enrich)).toMatchObject({ routine: true, summary: 'Nothing new to look up.' });
    expect(summarizeJobs(views, 1)).toMatchObject({ running: 0, waiting: 0, needsAttention: 1, routineHidden: 1 });
  });
});

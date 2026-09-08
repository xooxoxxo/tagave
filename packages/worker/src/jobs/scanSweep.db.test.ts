/**
 * scan.sweep against a real database: a never-finished scan is marked
 * aborted (the status the 0020 check allows) and the root gets its scan.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { libraries, scanRoots, scans, users, makeDb } from '@liner/db';
import pino from 'pino';
import type { WorkerContext } from '../lib/context.js';
import { scanSweepJob, STALE_RUNNING_MS } from './scanSweep.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('scanSweepJob (db)', () => {
  let ctx: WorkerContext;
  let db: any;
  let client: any;
  let userId: string;
  let libraryId: string;
  let rootId: string;
  const sent: Array<{ name: string; data: unknown; opts: unknown }> = [];

  beforeAll(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL not set — these suites delete rows and must never run against DATABASE_URL');
    const made = await makeDb(databaseUrl);
    db = made.db;
    client = made.client;
    const boss = { send: async (name: string, data: unknown, opts: unknown) => { sent.push({ name, data, opts }); return randomUUID(); } };
    ctx = { db: made.db, sql: made.client, boss: boss as any, logger: pino({ level: 'silent' }) };

    userId = randomUUID();
    await db.insert(users).values({ id: userId, email: `sweep-${userId}@test.com`, passwordHash: 'x' });
    libraryId = randomUUID();
    await db.insert(libraries).values({ id: libraryId, name: 'Sweep', ownerUserId: userId, settings: {} });
    rootId = randomUUID();
    await db.insert(scanRoots).values({ id: rootId, libraryId, path: '/tmp/sweep-root', displayName: 'sweep', validationStatus: 'ok', pollIntervalS: 3600 });
  });

  afterAll(async () => {
    await db.delete(scanRoots).where(eq(scanRoots.id, rootId)); // cascades scans
    await db.delete(libraries).where(eq(libraries.id, libraryId));
    await db.delete(users).where(eq(users.id, userId));
    await client.end({ timeout: 5 });
  });

  it('marks a never-finished scan aborted and enqueues a full scan', async () => {
    const staleStart = new Date(Date.now() - STALE_RUNNING_MS - 60_000);
    const [stale] = await db.insert(scans).values({ scanRootId: rootId, status: 'running', startedAt: staleStart, stats: {} }).returning({ id: scans.id });

    await scanSweepJob(ctx, {});

    const [row] = await db.select().from(scans).where(eq(scans.id, stale.id));
    expect(row.status).toBe('aborted');
    expect(row.finishedAt).not.toBeNull();
    expect((row.stats as { error?: string }).error).toMatch(/stale/);
    const mine = sent.filter((s) => (s.data as { scanRootId?: string }).scanRootId === rootId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.name).toBe('scan.root');
    expect(mine[0]!.data).toEqual({ scanRootId: rootId, mode: 'full' });
    expect(mine[0]!.opts).toEqual({ singletonKey: `scan:${rootId}` });
  });

  it('leaves a fresh running scan alone', async () => {
    sent.length = 0;
    await db.insert(scans).values({ scanRootId: rootId, status: 'running', startedAt: new Date(), stats: { mode: 'full' } });
    await scanSweepJob(ctx, {});
    expect(sent.filter((s) => (s.data as { scanRootId?: string }).scanRootId === rootId)).toHaveLength(0);
  });
});

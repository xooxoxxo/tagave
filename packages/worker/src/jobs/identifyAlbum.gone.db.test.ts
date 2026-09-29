/**
 * identify.album for an album that was merged away (or retired by regrouping)
 * while its job waited or ran: no error, a debug line, nothing written.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { libraries, localAlbums, matchCandidates, users, makeDb } from '@liner/db';
import type { WorkerContext } from '../lib/context.js';
import { identifyAlbumJob, unlessAlbumGone } from './identifyAlbum.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('identify on a merged-away album (db)', () => {
  let ctx: WorkerContext;
  let db: any;
  let client: any;
  const userId = randomUUID();
  const libraryId = randomUUID();
  const logs: Array<{ level: string; msg: string }> = [];
  const logger = {
    debug: (_o: unknown, msg: string) => logs.push({ level: 'debug', msg }),
    info: (_o: unknown, msg: string) => logs.push({ level: 'info', msg }),
    warn: (_o: unknown, msg: string) => logs.push({ level: 'warn', msg }),
    error: (_o: unknown, msg: string) => logs.push({ level: 'error', msg }),
  };

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;
    ctx = { db: made.db, sql: made.client, boss: {} as any, logger: logger as any };
    await db.insert(users).values({ id: userId, email: `gone-${userId}@test.com`, passwordHash: 'x' });
    await db.insert(libraries).values({ id: libraryId, name: 'Gone', ownerUserId: userId, settings: {} });
  });

  afterAll(async () => {
    await db.delete(libraries).where(eq(libraries.id, libraryId));
    await db.delete(users).where(eq(users.id, userId));
    await client.end({ timeout: 5 });
  });

  it('returns quietly when the album is already gone', async () => {
    logs.length = 0;
    await expect(identifyAlbumJob(ctx, { localAlbumId: randomUUID() })).resolves.toBeUndefined();
    expect(logs.map((l) => l.level)).toEqual(['debug']);
  });

  it('swallows the foreign-key failure when the album disappears mid-run', async () => {
    logs.length = 0;
    const albumId = randomUUID();
    await db.insert(localAlbums).values({ id: albumId, libraryId, clusterKey: `k-${albumId}`, dirPaths: ['x'], state: 'pending' });
    const run = async () => {
      // what a merge does while the providers answer
      await db.delete(localAlbums).where(eq(localAlbums.id, albumId));
      await db.insert(matchCandidates).values({ localAlbumId: albumId, releaseId: randomUUID(), distance: '0.1000', breakdown: {}, source: 'mb_search' });
    };
    await expect(unlessAlbumGone(ctx, albumId, run)).resolves.toBeUndefined();
    expect(logs.map((l) => l.level)).toEqual(['debug']);
  });

  it('still fails when the album exists', async () => {
    const albumId = randomUUID();
    await db.insert(localAlbums).values({ id: albumId, libraryId, clusterKey: `k-${albumId}`, dirPaths: ['x'], state: 'pending' });
    await expect(unlessAlbumGone(ctx, albumId, async () => { throw new Error('provider down'); })).rejects.toThrow('provider down');
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { audioFiles, libraries, localAlbums, localTracks, scanRoots, users, makeDb } from '@liner/db';
import { scanRootCounts } from './scanRootCounts.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('scanRootCounts', () => {
  let db: any;
  let client: any;
  const userId = randomUUID();
  const libraryId = randomUUID();
  const rootA = randomUUID();
  const rootB = randomUUID();
  const rootEmpty = randomUUID();

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;
    await db.insert(users).values({ id: userId, email: `rootcounts-${userId}@test.com`, passwordHash: 'x' });
    await db.insert(libraries).values({ id: libraryId, name: 'Counts', ownerUserId: userId, settings: {} });
    await db.insert(scanRoots).values([
      { id: rootA, libraryId, path: '/tmp/a', displayName: 'a', validationStatus: 'ok' },
      { id: rootB, libraryId, path: '/tmp/b', displayName: 'b', validationStatus: 'ok' },
      { id: rootEmpty, libraryId, path: '/tmp/c', displayName: 'c', validationStatus: 'ok' },
    ]);
    const album = async () => {
      const id = randomUUID();
      await db.insert(localAlbums).values({ id, libraryId, clusterKey: `k-${id}`, dirPaths: ['x'], state: 'matched' });
      return id;
    };
    const a1 = await album();
    const a2 = await album();
    const b1 = await album();
    const file = async (scanRootId: string, albumId: string | null, status = 'present') => {
      const id = randomUUID();
      await db.insert(audioFiles).values({ id, libraryId, scanRootId, relPath: `${id}.flac`, sizeBytes: 1, mtime: 1, status });
      if (albumId) await db.insert(localTracks).values({ localAlbumId: albumId, audioFileId: id, trackNo: 1 });
    };
    await file(rootA, a1);
    await file(rootA, a1);
    await file(rootA, a2);
    await file(rootA, null); // scanned, not clustered yet
    await file(rootA, a2, 'missing'); // gone from disk: not counted
    await file(rootB, b1);
  });

  afterAll(async () => {
    await db.delete(libraries).where(eq(libraries.id, libraryId));
    await db.delete(users).where(eq(users.id, userId));
    await client.end({ timeout: 5 });
  });

  it('counts present files and the albums they belong to, per root', async () => {
    const counts = await scanRootCounts(db, libraryId);
    expect(counts.get(rootA)).toEqual({ albumsFound: 2, tracksFound: 4 });
    expect(counts.get(rootB)).toEqual({ albumsFound: 1, tracksFound: 1 });
    expect(counts.has(rootEmpty)).toBe(false);
  });
});

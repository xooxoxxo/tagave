/**
 * "Show albums in this folder" (album page → albums list): the `folder`
 * filter matches the folder itself and anything below it, never a sibling
 * whose name merely starts the same ('A/B' must not match 'A/BC'), and
 * `root` narrows it to one scan root (the same relative path can exist
 * under two roots).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { audioFiles, libraries, localAlbums, localTracks, scanRoots, users, makeDb } from '@liner/db';
import { albumQueryParts } from './albums.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('albums list: folder filter (db)', () => {
  let db: any;
  let client: any;
  const userId = randomUUID();
  const libraryId = randomUUID();
  const rootA = randomUUID();
  const rootB = randomUUID();
  const ids: Record<string, string> = {};

  const album = async (name: string, dir: string, rootId: string) => {
    const id = randomUUID();
    ids[name] = id;
    await db.insert(localAlbums).values({ id, libraryId, clusterKey: `${rootId}/${dir}`, dirPaths: [dir], titleGuess: name, artistGuess: 'Test' });
    const fileId = randomUUID();
    await db.insert(audioFiles).values({ id: fileId, libraryId, scanRootId: rootId, relPath: `${dir}/01.flac` });
    await db.insert(localTracks).values({ localAlbumId: id, audioFileId: fileId, trackNo: 1 });
  };

  const names = async (query: Record<string, unknown>) => {
    const { conds } = albumQueryParts(libraryId, userId, query);
    const rows = await db.select({ id: localAlbums.id }).from(localAlbums).where(and(...conds));
    const byId = new Map(Object.entries(ids).map(([n, id]) => [id, n]));
    return rows.map((r: { id: string }) => byId.get(r.id)).sort();
  };

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;
    await db.insert(users).values({ id: userId, email: `ff-${userId}@test.com`, passwordHash: 'x' });
    await db.insert(libraries).values({ id: libraryId, name: 'Folder filter', ownerUserId: userId });
    await db.insert(scanRoots).values([
      { id: rootA, libraryId, path: '/music/a', displayName: 'A' },
      { id: rootB, libraryId, path: '/music/b', displayName: 'B' },
    ]);
    await album('ab', 'A/B', rootA);
    await album('abc', 'A/B/C', rootA);
    await album('abSibling', 'A/BC', rootA);
    await album('abOtherRoot', 'A/B', rootB);
  });

  afterAll(async () => {
    await db.delete(localAlbums).where(eq(localAlbums.libraryId, libraryId));
    await db.delete(audioFiles).where(eq(audioFiles.libraryId, libraryId));
    await db.delete(scanRoots).where(eq(scanRoots.libraryId, libraryId));
    await db.delete(libraries).where(eq(libraries.id, libraryId));
    await db.delete(users).where(eq(users.id, userId));
    await client.end();
  });

  it('matches the folder and below it, never a sibling with the same prefix', async () => {
    expect(await names({ folder: 'A/B' })).toEqual(['ab', 'abOtherRoot', 'abc']);
  });

  it('a trailing slash means the same folder', async () => {
    expect(await names({ folder: 'A/B/' })).toEqual(['ab', 'abOtherRoot', 'abc']);
  });

  it('root narrows the folder to one scan root', async () => {
    expect(await names({ folder: 'A/B', root: rootA })).toEqual(['ab', 'abc']);
    expect(await names({ folder: 'A/B', root: rootB })).toEqual(['abOtherRoot']);
  });

  it('a malformed root matches nothing instead of failing the query', async () => {
    expect(await names({ folder: 'A/B', root: 'not-a-uuid' })).toEqual([]);
  });

  it('no folder: the whole library', async () => {
    expect(await names({})).toHaveLength(4);
  });
});

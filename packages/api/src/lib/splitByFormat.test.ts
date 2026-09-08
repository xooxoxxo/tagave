import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import {
  audioFiles, clusterOverrides, libraries, localAlbums, localTracks, scanRoots, users, makeDb,
} from '@liner/db';
import { splitAlbumByFormat, mergeSplitAlbum, splitOriginOf, SplitError } from './splitByFormat.js';

describe('splitOriginOf', () => {
  it('reads the original id from a split key and rejects the rest', () => {
    const id = randomUUID();
    expect(splitOriginOf(`split:${id}:lossy`)).toBe(id);
    expect(splitOriginOf('abc123')).toBeNull();
    expect(splitOriginOf('split:not-a-uuid:lossy')).toBeNull();
    expect(splitOriginOf(null)).toBeNull();
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('splitAlbumByFormat / mergeSplitAlbum', () => {
  let db: any;
  let client: any;
  let userId: string;
  let libraryId: string;
  let rootId: string;
  let albumId: string;
  const fileIds: string[] = [];

  beforeAll(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL not set — these suites delete rows and must never run against DATABASE_URL');
    const made = await makeDb(databaseUrl);
    db = made.db;
    client = made.client;

    userId = randomUUID();
    await db.insert(users).values({ id: userId, email: `split-${userId}@test.com`, passwordHash: 'x' });
    libraryId = randomUUID();
    await db.insert(libraries).values({ id: libraryId, name: 'Split', ownerUserId: userId, settings: {} });
    rootId = randomUUID();
    await db.insert(scanRoots).values({ id: rootId, libraryId, path: '/tmp/split-root', displayName: 'split', validationStatus: 'ok' });

    albumId = randomUUID();
    await db.insert(localAlbums).values({
      id: albumId, libraryId, clusterKey: `test-${albumId}`, dirPaths: ['Artist/Album'],
      titleGuess: 'Album', artistGuess: 'Artist', yearGuess: 2001, discCount: 1,
      trackCount: 6, totalDurationMs: 6000, formats: ['flac', 'mp3'], state: 'matched',
    });
    const specs = [
      ['Artist/Album/01.flac', true], ['Artist/Album/02.flac', true], ['Artist/Album/03.flac', true],
      ['Artist/Album/01.mp3', false], ['Artist/Album/02.mp3', false], ['Artist/Album/03.mp3', null],
    ] as const;
    for (const [relPath, lossless] of specs) {
      const id = randomUUID();
      fileIds.push(id);
      await db.insert(audioFiles).values({ id, libraryId, scanRootId: rootId, relPath, sizeBytes: 10, mtime: 1, lossless, durationMs: 1000, status: 'present' });
      await db.insert(localTracks).values({ localAlbumId: albumId, audioFileId: id, trackNo: 1, titleGuess: relPath, durationMs: 1000 });
    }
  });

  afterAll(async () => {
    await db.delete(clusterOverrides).where(inArray(clusterOverrides.audioFileId, fileIds));
    await db.delete(localTracks).where(inArray(localTracks.audioFileId, fileIds));
    await db.delete(localAlbums).where(eq(localAlbums.libraryId, libraryId));
    await db.delete(scanRoots).where(eq(scanRoots.id, rootId));
    await db.delete(libraries).where(eq(libraries.id, libraryId));
    await db.delete(users).where(eq(users.id, userId));
    await client.end({ timeout: 5 });
  });

  let newAlbumId: string;

  it('moves the lossy copies (null lossless counts as lossy) into a pinned new album', async () => {
    const r = await splitAlbumByFormat(db, { libraryId, albumId, userId, keep: 'lossless' });
    newAlbumId = r.newAlbumId;
    expect(r.movedFileIds).toHaveLength(3);
    expect(r.keptFileIds).toHaveLength(3);
    expect(r.dirs).toEqual([{ scanRootId: rootId, dirPath: 'Artist/Album' }]);

    const [created] = await db.select().from(localAlbums).where(eq(localAlbums.id, newAlbumId));
    expect(created).toMatchObject({ titleGuess: 'Album', artistGuess: 'Artist', yearGuess: 2001, trackCount: 3, formats: ['mp3'], state: 'pending', dirPaths: ['Artist/Album'] });
    expect(splitOriginOf(created.clusterKey)).toBe(albumId);

    const [original] = await db.select().from(localAlbums).where(eq(localAlbums.id, albumId));
    expect(original).toMatchObject({ trackCount: 3, formats: ['flac'], state: 'matched' });

    const moved = await db.select().from(localTracks).where(eq(localTracks.localAlbumId, newAlbumId));
    expect(moved).toHaveLength(3);
    const pins = await db.select().from(clusterOverrides).where(eq(clusterOverrides.localAlbumId, newAlbumId));
    expect(pins).toHaveLength(3);
    expect(pins.every((p: any) => p.createdBy === userId)).toBe(true);
  });

  it('refuses to split an album that is no longer mixed, or a split-off album', async () => {
    await expect(splitAlbumByFormat(db, { libraryId, albumId, userId, keep: 'lossless' })).rejects.toMatchObject({ status: 409 });
    await expect(splitAlbumByFormat(db, { libraryId, albumId: newAlbumId, userId, keep: 'lossy' })).rejects.toBeInstanceOf(SplitError);
    await expect(splitAlbumByFormat(db, { libraryId, albumId: randomUUID(), userId, keep: 'lossless' })).rejects.toMatchObject({ status: 404 });
  });

  it('merge back returns the files, drops the pins and the split-off album, and restores the counters', async () => {
    const r = await mergeSplitAlbum(db, { libraryId, albumId: newAlbumId });
    expect(r.originalAlbumId).toBe(albumId);
    expect(r.fileIds).toHaveLength(3);
    expect(r.dirs).toEqual([{ scanRootId: rootId, dirPath: 'Artist/Album' }]);

    expect(await db.select().from(localAlbums).where(eq(localAlbums.id, newAlbumId))).toHaveLength(0);
    expect(await db.select().from(clusterOverrides).where(inArray(clusterOverrides.audioFileId, fileIds))).toHaveLength(0);
    const tracks = await db.select().from(localTracks).where(eq(localTracks.localAlbumId, albumId));
    expect(tracks).toHaveLength(6);
    const [original] = await db.select().from(localAlbums).where(eq(localAlbums.id, albumId));
    expect(original.trackCount).toBe(6);
    expect(original.formats).toEqual(['flac', 'mp3']);
    expect(original.totalDurationMs).toBe(6000);
  });

  it('merge back refuses an album that was not split off', async () => {
    await expect(mergeSplitAlbum(db, { libraryId, albumId })).rejects.toMatchObject({ status: 409 });
  });
});

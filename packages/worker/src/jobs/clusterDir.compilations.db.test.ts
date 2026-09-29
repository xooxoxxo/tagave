/**
 * cluster.dir and compilations against a real database: a folder whose album
 * artist carries each track's number, a folder whose album artist copies each
 * track's artist, and a real name that starts with a number.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { audioFiles, libraries, localAlbums, scanRoots, users, makeDb } from '@liner/db';
import pino from 'pino';
import type { WorkerContext } from '../lib/context.js';
import { clusterDirJob } from './clusterDir.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('clusterDirJob compilations (db)', () => {
  let ctx: WorkerContext;
  let db: any;
  let client: any;
  const userId = randomUUID();
  const libraryId = randomUUID();
  const rootId = randomUUID();

  const addFile = async (relPath: string, common: Record<string, unknown>) => {
    await db.insert(audioFiles).values({ id: randomUUID(), libraryId, scanRootId: rootId, relPath, status: 'present', durationMs: 1000, tagsRaw: { common } });
  };
  const albums = async () => db.select().from(localAlbums).where(eq(localAlbums.libraryId, libraryId));

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;
    ctx = { db: made.db, sql: made.client, boss: { send: async () => randomUUID() } as any, logger: pino({ level: 'silent' }) };
    await db.insert(users).values({ id: userId, email: `comp-${userId}@test.com`, passwordHash: 'x' });
    await db.insert(libraries).values({ id: libraryId, name: 'Comp', ownerUserId: userId, settings: {} });
    await db.insert(scanRoots).values({ id: rootId, libraryId, path: '/tmp/liner-comp-root', displayName: 'comp', validationStatus: 'ok', pollIntervalS: 3600 });
  });

  beforeEach(async () => {
    await db.delete(audioFiles).where(eq(audioFiles.scanRootId, rootId));
    await db.delete(localAlbums).where(eq(localAlbums.libraryId, libraryId));
  });

  afterAll(async () => {
    await db.delete(localAlbums).where(eq(localAlbums.libraryId, libraryId));
    await db.delete(scanRoots).where(eq(scanRoots.id, rootId));
    await db.delete(libraries).where(eq(libraries.id, libraryId));
    await db.delete(users).where(eq(users.id, userId));
    await client.end({ timeout: 5 });
  });

  it('a track number baked into the album artist no longer splits the folder', async () => {
    const dir = 'H/Hotel Costes Vol. 11';
    const artists = ['Lena Horne', 'Morten Varano', 'Vanessa Da Mata', 'Pacha Massive'];
    for (const [i, artist] of artists.entries()) {
      await addFile(`${dir}/0${i + 1}.mp3`, { album: 'Hotel Costes Vol. 11', albumartist: `0${i + 1}. Stephane Pompougnac`, artist, track: { no: i + 1, of: null } });
    }
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: dir });
    const rows = await albums();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ artistGuess: 'Stephane Pompougnac', trackCount: 4 });
  });

  it('album artists that copy each track artist make one Various Artists album', async () => {
    const dir = 'C/Cafe del Mar 5';
    for (const [i, artist] of ['A', 'B', 'C', 'D', 'E'].entries()) {
      await addFile(`${dir}/0${i + 1}.flac`, { album: 'Café del Mar 5', albumartist: artist, artist, track: { no: i + 1, of: null } });
    }
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: dir });
    const rows = await albums();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ artistGuess: 'Various Artists', trackCount: 5 });
  });

  it('keeps a name that starts with a number when it is not the track number, and two real album artists apart', async () => {
    const dir = 'S/Split';
    await addFile(`${dir}/01.flac`, { album: 'Split EP', albumartist: '7. Seconds', artist: '7. Seconds', track: { no: 1, of: null } });
    await addFile(`${dir}/02.flac`, { album: 'Split EP', albumartist: 'Other Band', artist: 'Other Band', track: { no: 2, of: null } });
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: dir });
    const rows = await albums();
    expect(rows.map((r: any) => r.artistGuess).sort()).toEqual(['7. Seconds', 'Other Band']);
  });
});

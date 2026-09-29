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

  it('keeps a name that starts with a number when it is not the track number', async () => {
    const dir = 'S/Seconds';
    await addFile(`${dir}/01.flac`, { album: 'Walk Together', albumartist: '7. Seconds', artist: '7. Seconds', track: { no: 1, of: null } });
    await addFile(`${dir}/02.flac`, { album: 'Walk Together', albumartist: '7. Seconds', artist: '7. Seconds', track: { no: 2, of: null } });
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: dir });
    const rows = await albums();
    expect(rows.map((r: any) => r.artistGuess)).toEqual(['7. Seconds']);
  });

  it('two or three copied album artists in one folder under one title are one album', async () => {
    const dir = 'S/Split';
    await addFile(`${dir}/01.flac`, { album: 'Split EP', albumartist: 'One Band', artist: 'One Band', track: { no: 1, of: null } });
    await addFile(`${dir}/02.flac`, { album: 'Split EP', albumartist: 'Other Band', artist: 'Other Band', track: { no: 2, of: null } });
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: dir });
    const rows = await albums();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ artistGuess: 'Various Artists', trackCount: 2 });
  });

  it('two album artists in different folders stay apart', async () => {
    await addFile('A/One Band/Greatest Hits/01.flac', { album: 'Greatest Hits', albumartist: 'One Band', artist: 'One Band', track: { no: 1, of: null } });
    await addFile('A/Other Band/Greatest Hits/01.flac', { album: 'Greatest Hits', albumartist: 'Other Band', artist: 'Other Band', track: { no: 1, of: null } });
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: 'A/One Band/Greatest Hits' });
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: 'A/Other Band/Greatest Hits' });
    const rows = await albums();
    expect(rows.map((r: any) => r.artistGuess).sort()).toEqual(['One Band', 'Other Band']);
  });

  it('prod layout, one folder per track: a new cluster key keeps the album id, its match and its locks', async () => {
    // "#/02. Stephane Pompougnac/2008 - Hotel Costes Vol. 11/02 - Title.mp3":
    // each folder holds one file, so each is its own album either way; the
    // rule change only renames the key. Before 0028's rule the key carried
    // the numbered artist; seed rows under that old key as a deploy finds them.
    const { clusterKey, normKey } = await import('../lib/helpers.js');
    const { fieldLocks, localTracks } = await import('@liner/db');
    const ids: string[] = [];
    for (const n of [2, 3]) {
      const nn = String(n).padStart(2, '0');
      const dir = `#/${nn}. Stephane Pompougnac/2008 - Hotel Costes Vol. 11`;
      const fileId = randomUUID();
      await db.insert(audioFiles).values({
        id: fileId, libraryId, scanRootId: rootId, relPath: `${dir}/${nn} - Title.mp3`, status: 'present', durationMs: 1000,
        tagsRaw: { common: { album: 'Hotel Costes Vol. 11', albumartist: `${nn}. Stephane Pompougnac`, artist: `Artist ${n}`, track: { no: n, of: null } } },
      });
      const oldKey = clusterKey(libraryId, [dir], normKey('Hotel Costes Vol. 11'), normKey(`${nn}. Stephane Pompougnac`));
      const albumId = randomUUID();
      ids.push(albumId);
      await db.insert(localAlbums).values({
        id: albumId, libraryId, clusterKey: oldKey, dirPaths: [dir], titleGuess: 'Hotel Costes Vol. 11',
        artistGuess: `${nn}. Stephane Pompougnac`, trackCount: 1, state: n === 2 ? 'matched' : 'unidentified',
        releaseId: n === 2 ? randomUUID() : null,
      });
      await db.insert(localTracks).values({ localAlbumId: albumId, audioFileId: fileId, trackNo: n, state: 'unmatched' });
      await db.insert(fieldLocks).values({ libraryId, scope: 'album', scopeId: albumId, field: 'albumartist', value: 'Stephane Pompougnac', createdBy: userId });
    }
    for (const n of [2, 3]) {
      const nn = String(n).padStart(2, '0');
      await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: `#/${nn}. Stephane Pompougnac/2008 - Hotel Costes Vol. 11` });
    }
    const rows = await albums();
    expect(rows.map((r: any) => r.id).sort()).toEqual([...ids].sort());
    const two = rows.find((r: any) => r.id === ids[0]);
    expect(two).toMatchObject({ state: 'matched', artistGuess: 'Stephane Pompougnac' });
    expect(two.releaseId).not.toBeNull();
    expect(rows.find((r: any) => r.id === ids[1])).toMatchObject({ state: 'unidentified' });
    const locks = await db.select().from(fieldLocks).where(eq(fieldLocks.libraryId, libraryId));
    expect(locks.filter((l: any) => l.scope === 'album').map((l: any) => l.scopeId).sort()).toEqual([...ids].sort());
    await db.delete(fieldLocks).where(eq(fieldLocks.libraryId, libraryId));
  });

  it('albums absorbed into one regrouped album hand their locks to their files', async () => {
    // Copied album artists: before the rule, each artist was its own album
    // in the same folder; after, one album. The matched one keeps its id,
    // the other goes, and its album lock becomes a lock on its file.
    const { clusterKey, normKey } = await import('../lib/helpers.js');
    const { fieldLocks, localTracks } = await import('@liner/db');
    const dir = 'C/Compilation';
    const made: Array<{ albumId: string; fileId: string }> = [];
    for (const [i, artist] of ['One Band', 'Other Band'].entries()) {
      const fileId = randomUUID();
      await db.insert(audioFiles).values({
        id: fileId, libraryId, scanRootId: rootId, relPath: `${dir}/0${i + 1}.flac`, status: 'present', durationMs: 1000,
        tagsRaw: { common: { album: 'Compilation', albumartist: artist, artist, track: { no: i + 1, of: null } } },
      });
      const albumId = randomUUID();
      await db.insert(localAlbums).values({
        id: albumId, libraryId, clusterKey: clusterKey(libraryId, [dir], normKey('Compilation'), normKey(artist)),
        dirPaths: [dir], titleGuess: 'Compilation', artistGuess: artist, trackCount: 1, state: i === 0 ? 'matched' : 'unidentified',
      });
      await db.insert(localTracks).values({ localAlbumId: albumId, audioFileId: fileId, trackNo: i + 1, state: 'unmatched' });
      made.push({ albumId, fileId });
    }
    await db.insert(fieldLocks).values({ libraryId, scope: 'album', scopeId: made[1]!.albumId, field: 'genre', value: ['Punk'], createdBy: userId });
    await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: dir });
    const rows = await albums();
    expect(rows).toHaveLength(1);
    // kept its id; it now holds more files than its match described
    expect(rows[0]).toMatchObject({ id: made[0]!.albumId, state: 'pending', trackCount: 2, artistGuess: 'Various Artists' });
    const locks = await db.select().from(fieldLocks).where(eq(fieldLocks.libraryId, libraryId));
    expect(locks.map((l: any) => ({ scope: l.scope, scopeId: l.scopeId, field: l.field }))).toEqual([
      { scope: 'track', scopeId: made[1]!.fileId, field: 'genre' },
    ]);
    await db.delete(fieldLocks).where(eq(fieldLocks.libraryId, libraryId));
  });
});

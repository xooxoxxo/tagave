/**
 * After an apply: the folders the plan wrote are re-clustered, and an album
 * built by "Treat as one album" takes the title and album artist its files
 * now agree on. The prod case: three folders merged into "The Last Tycoon
 * [2008]" by "Various Artists", then a set-values plan wrote "The Last
 * Tycoon" / "Peter Moren" to every file, and the album kept the old names.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import {
  audioFiles, clusterOverrides, libraries, localAlbums, localTracks, scanRoots, tagPlanItems, tagPlans, users, makeDb,
} from '@liner/db';
import type { WorkerContext } from '../lib/context.js';
import { clusterDirJob, agreedAlbumNames } from './clusterDir.js';
import { reclusterWrittenDirs } from './tagsApply.js';

describe('agreedAlbumNames', () => {
  const tags = (album: string | null, albumartist: string | null, year: number | null = null) =>
    ({ album, albumartist, artist: null, disc: null, track: null, title: null, year });

  it('takes a value every file agrees on, ignoring case', () => {
    expect(agreedAlbumNames([tags('The Last Tycoon', 'Peter Moren', 2008), tags('the last tycoon', 'Peter Moren', 2008)]))
      .toEqual({ title: 'The Last Tycoon', artist: 'Peter Moren', year: 2008 });
  });

  it('keeps the current value when the files disagree or one has no tag', () => {
    expect(agreedAlbumNames([tags('A', 'X'), tags('B', null)])).toEqual({ title: null, artist: null, year: null });
    expect(agreedAlbumNames([])).toEqual({ title: null, artist: null, year: null });
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('re-cluster after apply (db)', () => {
  let ctx: WorkerContext;
  let db: any;
  let client: any;
  const sent: Array<{ name: string; data: any; opts: any }> = [];
  const userId = randomUUID();
  const libraryId = randomUUID();
  const rootId = randomUUID();
  const albumId = randomUUID();
  const planId = randomUUID();
  const dirs = ['#/02 Peter Moren/2008 - The Last Tycoon', '#/04 Peter Moren/2008 - The Last Tycoon', 'P/Peter Moren _ The Last Tycoon [2008]'];
  const fileIds = dirs.map(() => randomUUID());

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;
    ctx = {
      db: made.db,
      sql: made.client,
      boss: { send: async (name: string, data: unknown, opts: unknown) => { sent.push({ name, data, opts }); return randomUUID(); } } as any,
      logger: pino({ level: 'silent' }),
    };
    await db.insert(users).values({ id: userId, email: `recluster-${userId}@test.com`, passwordHash: 'x' });
    await db.insert(libraries).values({ id: libraryId, name: 'Recluster', ownerUserId: userId, settings: {} });
    await db.insert(scanRoots).values({ id: rootId, libraryId, path: '/tmp/liner-recluster-root', displayName: 'rc', validationStatus: 'ok', pollIntervalS: 3600 });
    // The files as the plan left them: new tags already in tags_raw.
    for (const [i, dir] of dirs.entries()) {
      await db.insert(audioFiles).values({
        id: fileIds[i], libraryId, scanRootId: rootId, relPath: `${dir}/0${i + 1} - Track.mp3`, status: 'present', durationMs: 1000,
        tagsRaw: { common: { album: 'The Last Tycoon', albumartist: 'Peter Moren', artist: 'Peter Moren', year: 2008, track: { no: i + 1, of: null } } },
      });
    }
    // The merged album with the names the merge picked.
    await db.insert(localAlbums).values({
      id: albumId, libraryId, clusterKey: `merge:rc-${albumId}`, dirPaths: dirs, state: 'unidentified',
      titleGuess: 'The Last Tycoon [2008]', artistGuess: 'Various Artists', yearGuess: 2008, trackCount: 3,
      mergedFrom: { version: 1, target: {}, sources: [{}, {}], fileLockIds: [] },
    });
    for (const [i, fileId] of fileIds.entries()) {
      await db.insert(clusterOverrides).values({ libraryId, audioFileId: fileId, localAlbumId: albumId, createdBy: userId });
      await db.insert(localTracks).values({ localAlbumId: albumId, audioFileId: fileId, trackNo: i + 1, durationMs: 1000 });
    }
    await db.insert(tagPlans).values({
      id: planId, libraryId, name: 'Set values: The Last Tycoon', scope: { type: 'albumIds', albumIds: [albumId] },
      policy: { preset: 'manual', id3Version: '2.4', multiValueSeparator: '; ' }, status: 'applying', stats: {}, createdBy: userId,
    });
    for (const fileId of fileIds) {
      await db.insert(tagPlanItems).values({
        tagPlanId: planId, audioFileId: fileId, before: { album: 'x' }, after: { album: 'The Last Tycoon' },
        diff: [{ field: 'album', before: 'x', after: 'The Last Tycoon', reason: 'policy:overwrite' }], status: 'applied',
      });
    }
  });

  afterAll(async () => {
    await db.delete(tagPlans).where(eq(tagPlans.id, planId));
    await db.delete(localAlbums).where(eq(localAlbums.libraryId, libraryId));
    await db.delete(scanRoots).where(eq(scanRoots.id, rootId));
    await db.delete(libraries).where(eq(libraries.id, libraryId));
    await db.delete(users).where(eq(users.id, userId));
    await client.end({ timeout: 5 });
  });

  it('queues one cluster.dir per folder the plan wrote to', async () => {
    const queued = await reclusterWrittenDirs(ctx, planId);
    expect(queued).toBe(3);
    const jobs = sent.filter((j) => j.name === 'cluster.dir');
    expect(jobs.map((j) => j.data.dirPath).sort()).toEqual([...dirs].sort());
    for (const j of jobs) {
      expect(j.data).toMatchObject({ libraryId, scanRootId: rootId });
      expect(j.opts.singletonKey).toContain(j.data.dirPath);
    }
  });

  it('the re-cluster keeps the merge and gives the album the names its files agree on', async () => {
    for (const dirPath of dirs) await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath });
    const rows = await db.select().from(localAlbums).where(eq(localAlbums.libraryId, libraryId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: albumId, titleGuess: 'The Last Tycoon', artistGuess: 'Peter Moren', trackCount: 3 });
  });
});

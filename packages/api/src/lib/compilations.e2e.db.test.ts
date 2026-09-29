/**
 * The Hotel Costes scenario end to end against the test database, with the
 * worker's real cluster.dir and tags.preview jobs:
 *
 *   "#/01. Stephane Pompougnac/2008 - Hotel Costes Vol. 11/01 - ….mp3"
 *   "#/02. Stephane Pompougnac/2008 - Hotel Costes Vol. 11/02 - ….mp3" …
 *
 * one folder per track, the track number baked into ALBUMARTIST, a different
 * artist per track. Clustering shows one artist (numbering stripped); the
 * album page offers the other pieces; "Treat as one album" makes one album
 * that survives a rescan; the bulk editor suggests album-level values; a
 * manual plan previews real diffs for the unidentified album; split back
 * restores the pieces.
 *
 * The worker jobs are imported at run time by path: the api does not depend
 * on the worker package, and this test is the one place that needs both.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, inArray } from 'drizzle-orm';
import {
  audioFiles, clusterOverrides, fieldLocks, libraries, localAlbums, localTracks, scanRoots, tagPlanItems, tagPlans, users, makeDb,
} from '@liner/db';
import { findMergeCandidates, mergeAlbums, unmergeAlbum, isMergedKey, MergeError } from './mergeAlbums.js';
import { filesOfAlbums, suggestBulkValues } from './bulkTagEdit.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const workerJob = (name: string) => path.resolve(here, '../../../worker/src/jobs', name);

const silent = { info() {}, warn() {}, debug() {}, error() {}, trace() {}, fatal() {}, child() { return silent; } };

describe.skipIf(!process.env.TEST_DATABASE_URL)('compilations: Hotel Costes end to end (db)', () => {
  let db: any;
  let client: any;
  let ctx: any;
  let clusterDirJob: (ctx: any, data: { libraryId: string; scanRootId: string; dirPath: string }) => Promise<void>;
  let tagsPreviewJob: (ctx: any, planId: string) => Promise<void>;
  const userId = randomUUID();
  const libraryId = randomUUID();
  const rootId = randomUUID();
  const tracks = [
    ['Lena Horne', 'I Want A Little Doggie'],
    ['Morten Varano', 'Dead And Street'],
    ['Vanessa Da Mata', 'Boa Sorte'],
    ['Pacha Massive', "Don't Let Go"],
  ] as const;
  const dirOf = (i: number) => `#/0${i + 1}. Stephane Pompougnac/2008 - Hotel Costes Vol. 11`;
  const dirs = tracks.map((_, i) => dirOf(i));
  const vaDir = 'V/Various/Hotel Costes 11 By Stephane Pompougnac';

  const albumsNow = async () => db.select().from(localAlbums).where(eq(localAlbums.libraryId, libraryId));
  const clusterAll = async () => {
    for (const d of [...dirs, vaDir]) await clusterDirJob(ctx, { libraryId, scanRootId: rootId, dirPath: d });
  };

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;
    ctx = { db: made.db, sql: made.client, boss: { send: async () => randomUUID() }, logger: silent };
    ({ clusterDirJob } = await import(/* @vite-ignore */ workerJob('clusterDir.ts')));
    ({ tagsPreviewJob } = await import(/* @vite-ignore */ workerJob('tagsPreview.ts')));

    await db.insert(users).values({ id: userId, email: `hc-${userId}@test.com`, passwordHash: 'x' });
    await db.insert(libraries).values({ id: libraryId, name: 'Compilations', ownerUserId: userId, settings: { tagWritesEnabled: true } });
    await db.insert(scanRoots).values({ id: rootId, libraryId, path: '/tmp/hc-root', displayName: 'hc', writable: true, validationStatus: 'ok' });
    for (const [i, [artist, title]] of tracks.entries()) {
      await db.insert(audioFiles).values({
        id: randomUUID(), libraryId, scanRootId: rootId, relPath: `${dirOf(i)}/0${i + 1} - ${title}.mp3`,
        sizeBytes: 1, mtime: 1, status: 'present', durationMs: 200_000,
        tagsRaw: { common: { title, artist, albumartist: `0${i + 1}. Stephane Pompougnac`, album: 'Hotel Costes Vol. 11', year: 2008, track: { no: i + 1, of: null } } },
      });
    }
    // The full copy filed elsewhere under another title: a different album, never a piece.
    for (const [i, [artist, title]] of tracks.entries()) {
      await db.insert(audioFiles).values({
        id: randomUUID(), libraryId, scanRootId: rootId, relPath: `${vaDir}/0${i + 1} - ${title}.mp3`,
        sizeBytes: 1, mtime: 1, status: 'present', durationMs: 200_000,
        tagsRaw: { common: { title, artist, albumartist: 'Various', album: 'Hotel Costes 11 By Stephane Pompougnac', track: { no: i + 1, of: null } } },
      });
    }
  });

  afterAll(async () => {
    await db.delete(tagPlanItems).where(inArray(tagPlanItems.tagPlanId,
      (await db.select({ id: tagPlans.id }).from(tagPlans).where(eq(tagPlans.libraryId, libraryId))).map((p: any) => p.id).concat([randomUUID()])));
    await db.delete(tagPlans).where(eq(tagPlans.libraryId, libraryId));
    await db.delete(clusterOverrides).where(eq(clusterOverrides.libraryId, libraryId));
    await db.delete(fieldLocks).where(eq(fieldLocks.libraryId, libraryId));
    await db.delete(scanRoots).where(eq(scanRoots.id, rootId)); // cascades files and their tracks
    await db.delete(localAlbums).where(eq(localAlbums.libraryId, libraryId));
    await db.delete(libraries).where(eq(libraries.id, libraryId));
    await db.delete(users).where(eq(users.id, userId));
    await client.end({ timeout: 5 });
  });

  let pieces: any[];
  let targetId: string;

  it('clusters one album per folder, but under one artist: the track number comes off the album artist', async () => {
    await clusterAll();
    const all = await albumsNow();
    pieces = all.filter((a: any) => a.titleGuess === 'Hotel Costes Vol. 11');
    expect(pieces).toHaveLength(4);
    expect(new Set(pieces.map((a: any) => a.artistGuess))).toEqual(new Set(['Stephane Pompougnac']));
    expect(pieces.every((a: any) => a.trackCount === 1)).toBe(true);
    const va = all.find((a: any) => a.titleGuess === 'Hotel Costes 11 By Stephane Pompougnac');
    expect(va.trackCount).toBe(4);
  });

  it('offers the other pieces on the album page, not the differently titled full copy', async () => {
    targetId = pieces.find((a: any) => a.dirPaths[0] === dirOf(1)).id;
    const candidates = await findMergeCandidates(db, { libraryId, albumId: targetId });
    expect(candidates.map((c) => c.id).sort()).toEqual(pieces.filter((a: any) => a.id !== targetId).map((a: any) => a.id).sort());
  });

  it('refuses to merge copies of the same tracks (the full copy overlaps every piece)', async () => {
    const va = (await albumsNow()).find((a: any) => a.titleGuess === 'Hotel Costes 11 By Stephane Pompougnac');
    const err = await mergeAlbums(db, { libraryId, albumIds: [targetId, va.id], userId }).catch((e) => e);
    expect(err).toBeInstanceOf(MergeError);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/both have track 2/);
    expect((await albumsNow()).find((a: any) => a.id === va.id)).toBeDefined();
  });

  let lockedPiece: any;
  let lockedFileId: string;

  it('treats the pieces as one album without moving a file, and a rescan keeps it', async () => {
    // An owner lock on one piece: after the merge it must still protect that file.
    lockedPiece = pieces.find((a: any) => a.dirPaths[0] === dirOf(0));
    const [t] = await db.select({ audioFileId: localTracks.audioFileId }).from(localTracks).where(eq(localTracks.localAlbumId, lockedPiece.id));
    lockedFileId = t.audioFileId;
    await db.insert(fieldLocks).values({ libraryId, scope: 'album', scopeId: lockedPiece.id, field: 'albumartist', value: '01. Stephane Pompougnac', createdBy: userId });

    const r = await mergeAlbums(db, { libraryId, albumIds: pieces.map((a: any) => a.id), userId, targetId });
    expect(r.albumId).toBe(targetId);
    expect(r.mergedAlbumIds).toHaveLength(3);
    expect(r.needsIdentify).toBe(true);

    const check = async () => {
      const all = await albumsNow();
      const hc = all.filter((a: any) => a.titleGuess === 'Hotel Costes Vol. 11');
      expect(hc).toHaveLength(1);
      expect(hc[0].id).toBe(targetId);
      expect(isMergedKey(hc[0].clusterKey)).toBe(true);
      expect(hc[0].trackCount).toBe(4);
      expect(hc[0].totalDurationMs).toBe(800_000);
      expect([...hc[0].dirPaths].sort()).toEqual([...dirs].sort());
      expect(hc[0].state).toBe('pending');
      const files = await db.select({ relPath: audioFiles.relPath }).from(audioFiles).where(eq(audioFiles.scanRootId, rootId));
      expect(files.filter((f: any) => f.relPath.startsWith('#/'))).toHaveLength(4); // nothing moved on disk
    };
    await check();
    await clusterAll(); // every folder rescanned
    await check();

    // the piece's album lock became a lock on its file; nothing points at the removed album
    const locks = await db.select().from(fieldLocks).where(eq(fieldLocks.libraryId, libraryId));
    expect(locks.map((l: any) => ({ scope: l.scope, scopeId: l.scopeId, field: l.field }))).toEqual([
      { scope: 'track', scopeId: lockedFileId, field: 'albumartist' },
    ]);
  });

  it('suggests album-level values: the stripped album artist, the title, the year, a compilation', async () => {
    const files = await filesOfAlbums(db, [targetId]);
    const s = suggestBulkValues(files, 1);
    expect(s.files).toBe(4);
    expect(s.numberedAlbumArtists).toBe(4);
    expect(s.trackArtistsDiffer).toBe(true);
    expect(s.suggested).toMatchObject({ albumartist: 'Stephane Pompougnac', album: 'Hotel Costes Vol. 11', date: '2008', compilation: '1' });
    expect(s.albumArtistOptions).toContain('Various Artists');
  });

  it('a manual plan previews real diffs for the unidentified album', async () => {
    const planId = randomUUID();
    await db.insert(tagPlans).values({
      id: planId, libraryId, name: 'Hotel Costes', scope: { type: 'albumIds', albumIds: [targetId] },
      policy: { preset: 'manual', id3Version: '2.4', multiValueSeparator: '; ', values: { albumartist: 'Various Artists', compilation: '1' } },
      status: 'draft', stats: {}, createdBy: userId,
    });
    await tagsPreviewJob(ctx, planId);
    const [plan] = await db.select().from(tagPlans).where(eq(tagPlans.id, planId));
    expect(plan.status).toBe('previewed');
    // the locked piece keeps its album artist: 4 files, 7 changes, 1 kept back
    expect(plan.stats).toMatchObject({ filesTouched: 4, fieldsModified: 7, lockedFieldsRespected: 1, filesSkipped: [] });
    const items = await db.select().from(tagPlanItems).where(eq(tagPlanItems.tagPlanId, planId));
    expect(items).toHaveLength(4);
    for (const item of items) {
      const fields = (item.diff as any[]).map((d) => d.field).sort();
      if (item.audioFileId === lockedFileId) {
        expect(fields).toEqual(['compilation']);
        continue;
      }
      expect(fields).toEqual(['albumartist', 'compilation']);
      expect((item.diff as any[]).find((d) => d.field === 'albumartist').before).toMatch(/^0\d\. Stephane Pompougnac$/);
    }
  });

  it('a folder plan covers exactly the files in the folder, not the rest of the merged album', async () => {
    const planId = randomUUID();
    await db.insert(tagPlans).values({
      id: planId, libraryId, name: 'One folder', scope: { type: 'folder', dirPath: dirOf(2) },
      policy: { preset: 'manual', id3Version: '2.4', multiValueSeparator: '; ', values: { genre: ['Lounge'] } },
      status: 'draft', stats: {}, createdBy: userId,
    });
    await tagsPreviewJob(ctx, planId);
    const [plan] = await db.select().from(tagPlans).where(eq(tagPlans.id, planId));
    expect(plan.stats).toMatchObject({ filesInScope: 1, filesTouched: 1, fieldsModified: 1 });
    const items = await db.select({ relPath: audioFiles.relPath }).from(tagPlanItems)
      .innerJoin(audioFiles, eq(audioFiles.id, tagPlanItems.audioFileId)).where(eq(tagPlanItems.tagPlanId, planId));
    expect(items.map((i: any) => i.relPath)).toEqual([`${dirOf(2)}/03 - Boa Sorte.mp3`]);
  });

  it('splits back into the pieces, as they were, even after the merged album was identified', async () => {
    // identification matched the merged whole to the full release; that
    // match cannot describe the one file the kept album holds afterwards
    await db.update(localAlbums).set({ state: 'matched', releaseId: randomUUID(), releaseGroupId: randomUUID(), identifyReason: null })
      .where(eq(localAlbums.id, targetId));

    const r = await unmergeAlbum(db, { libraryId, albumId: targetId });
    expect(r.restoredAlbumIds.sort()).toEqual(pieces.filter((a: any) => a.id !== targetId).map((a: any) => a.id).sort());
    expect([...r.dirs.map((d) => d.dirPath)].sort()).toEqual([...dirs].sort());
    expect(await db.select().from(clusterOverrides).where(eq(clusterOverrides.libraryId, libraryId))).toHaveLength(0);
    for (const d of r.dirs) await clusterDirJob(ctx, { libraryId, scanRootId: d.scanRootId, dirPath: d.dirPath });
    const hc = (await albumsNow()).filter((a: any) => a.titleGuess === 'Hotel Costes Vol. 11');
    expect(hc).toHaveLength(4);
    // every piece is back under its own id, not a fresh one
    expect(hc.map((a: any) => a.id).sort()).toEqual(pieces.map((a: any) => a.id).sort());
    expect(hc.every((a: any) => a.trackCount === 1 && !isMergedKey(a.clusterKey))).toBe(true);
    const kept = hc.find((a: any) => a.id === targetId);
    expect(kept).toMatchObject({ state: 'pending', releaseId: null, releaseGroupId: null, mergedFrom: null });
    // the lock is an album lock on its piece again
    const locks = await db.select().from(fieldLocks).where(eq(fieldLocks.libraryId, libraryId));
    expect(locks.map((l: any) => ({ scope: l.scope, scopeId: l.scopeId, field: l.field }))).toEqual([
      { scope: 'album', scopeId: lockedPiece.id, field: 'albumartist' },
    ]);
  });

  it('refuses to merge away an album that has a split-off copy', async () => {
    const [a, b] = (await albumsNow()).filter((x: any) => x.titleGuess === 'Hotel Costes Vol. 11');
    const splitId = randomUUID();
    await db.insert(localAlbums).values({ id: splitId, libraryId, clusterKey: `split:${b.id}:lossy`, titleGuess: 'Hotel Costes Vol. 11', state: 'pending' });
    try {
      const err = await mergeAlbums(db, { libraryId, albumIds: [a.id, b.id], userId, targetId: a.id }).catch((e) => e);
      expect(err).toBeInstanceOf(MergeError);
      expect(err.message).toMatch(/split off/);
    } finally {
      await db.delete(localAlbums).where(eq(localAlbums.id, splitId));
    }
  });
});

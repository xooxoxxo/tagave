/**
 * Database tests for per-track linking (0026).
 * Tests linkAlbumTracks, fillTrackIdsFromCache, and tracksLinkJob sweep behavior.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  audioFiles, canonicalTracks, libraries, localAlbums, localTracks,
  releases, releaseGroups, scanRoots, users, providerCache, makeDb,
} from '@liner/db';
import pino from 'pino';
import { linkAlbumTracks, fillTrackIdsFromCache } from './trackLinks.js';
import type { WorkerContext } from './context.js';
import type { CanonicalRelease } from '@liner/core';

describe.skipIf(!process.env.TEST_DATABASE_URL)('linkAlbumTracks (db)', () => {
  let ctx: WorkerContext;
  let db: any;
  let client: any;
  let userId: string;
  let libraryId: string;
  let rootId: string;
  let releaseId: string;
  let releaseGroupId: string;
  let albumId: string;

  beforeAll(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL not set');
    const made = await makeDb(databaseUrl);
    db = made.db;
    client = made.client;
    ctx = { db: made.db, sql: made.client, boss: {} as any, logger: pino({ level: 'silent' }) };

    userId = randomUUID();
    await db.insert(users).values({ id: userId, email: `linktest-${userId}@test.com`, passwordHash: 'x' });

    libraryId = randomUUID();
    await db.insert(libraries).values({ id: libraryId, name: 'LinkTest', ownerUserId: userId });

    rootId = randomUUID();
    await db.insert(scanRoots).values({ id: rootId, libraryId, path: '/link-test', displayName: 'LinkTest', writable: true });

    releaseGroupId = randomUUID();
    await db.insert(releaseGroups).values({
      id: releaseGroupId, mbid: 'link-rg-1', title: 'Link Test Album', artistCredit: [],
    });

    releaseId = randomUUID();
    await db.insert(releases).values({
      id: releaseId, releaseGroupId, mbid: 'link-rel-1', title: 'Link Test Album',
    });
  });

  afterAll(async () => {
    await db.delete(localTracks).where(eq(localTracks.localAlbumId, albumId));
    await db.delete(audioFiles).where(eq(audioFiles.libraryId, libraryId));
    await db.delete(localAlbums).where(eq(localAlbums.id, albumId));
    await db.delete(canonicalTracks).where(eq(canonicalTracks.releaseId, releaseId));
    await db.delete(releases).where(eq(releases.id, releaseId));
    await db.delete(releaseGroups).where(eq(releaseGroups.id, releaseGroupId));
    await db.delete(scanRoots).where(eq(scanRoots.id, rootId));
    await db.delete(libraries).where(eq(libraries.id, libraryId));
    await db.delete(users).where(eq(users.id, userId));
    await client.end({ timeout: 5 });
  });

  it('should link 3 local tracks to 3 canonical tracks in a flat album', async () => {
    albumId = randomUUID();
    // Create a specific release for this test
    const testReleaseId = randomUUID();
    await db.insert(releases).values({
      id: testReleaseId, releaseGroupId, mbid: 'link-rel-flat', title: 'Flat Album',
    });

    await db.insert(localAlbums).values({
      id: albumId, libraryId, clusterKey: `flat-${albumId}`, dirPaths: ['/link-test/flat'], titleGuess: 'Flat', artistGuess: 'Artist',
      state: 'matched', releaseId: testReleaseId, trackCount: 3, discCount: 1,
    });

    const file1 = randomUUID();
    const file2 = randomUUID();
    const file3 = randomUUID();
    await db.insert(audioFiles).values([
      { id: file1, libraryId, scanRootId: rootId, relPath: 'flat/01.mp3', sizeBytes: 1, mtime: 1, status: 'present', tagsRaw: {} },
      { id: file2, libraryId, scanRootId: rootId, relPath: 'flat/02.mp3', sizeBytes: 1, mtime: 1, status: 'present', tagsRaw: {} },
      { id: file3, libraryId, scanRootId: rootId, relPath: 'flat/03.mp3', sizeBytes: 1, mtime: 1, status: 'present', tagsRaw: {} },
    ]);

    const lt1 = randomUUID();
    const lt2 = randomUUID();
    const lt3 = randomUUID();
    await db.insert(localTracks).values([
      { id: lt1, localAlbumId: albumId, audioFileId: file1, discNo: null, trackNo: 1, titleGuess: 'Track 1', durationMs: 180000 },
      { id: lt2, localAlbumId: albumId, audioFileId: file2, discNo: null, trackNo: 2, titleGuess: 'Track 2', durationMs: 200000 },
      { id: lt3, localAlbumId: albumId, audioFileId: file3, discNo: null, trackNo: 3, titleGuess: 'Track 3', durationMs: 220000 },
    ]);

    const ct1 = randomUUID();
    const ct2 = randomUUID();
    const ct3 = randomUUID();
    await db.insert(canonicalTracks).values([
      { id: ct1, releaseId: testReleaseId, mediumNo: 1, position: 1, number: '1', title: 'Track 1', artistCredit: [], lengthMs: 180000 },
      { id: ct2, releaseId: testReleaseId, mediumNo: 1, position: 2, number: '2', title: 'Track 2', artistCredit: [], lengthMs: 200000 },
      { id: ct3, releaseId: testReleaseId, mediumNo: 1, position: 3, number: '3', title: 'Track 3', artistCredit: [], lengthMs: 220000 },
    ]);

    const result = await linkAlbumTracks(ctx, albumId);

    expect(result).not.toBeNull();
    expect(result?.linked).toBe(3);
    expect(result?.unaligned).toBe(0);

    const album = (await db.select().from(localAlbums).where(eq(localAlbums.id, albumId)))[0];
    expect(album?.tracksLinkedAt).not.toBeNull();

    const track1 = (await db.select().from(localTracks).where(eq(localTracks.id, lt1)))[0];
    expect(track1?.canonicalTrackId).toBe(ct1);
    expect(track1?.state).toBe('matched');

    // Cleanup
    await db.delete(localTracks).where(eq(localTracks.localAlbumId, albumId));
    await db.delete(audioFiles).where(eq(audioFiles.libraryId, libraryId));
    await db.delete(localAlbums).where(eq(localAlbums.id, albumId));
    await db.delete(canonicalTracks).where(eq(canonicalTracks.releaseId, testReleaseId));
    await db.delete(releases).where(eq(releases.id, testReleaseId));
  });

  it('should link 2-disc album to 2-medium release', async () => {
    const album2Id = randomUUID();
    const testReleaseId = randomUUID();
    await db.insert(releases).values({
      id: testReleaseId, releaseGroupId, mbid: 'link-rel-multi', title: 'Multi Album',
    });

    await db.insert(localAlbums).values({
      id: album2Id, libraryId, clusterKey: `multi-${album2Id}`, dirPaths: ['/link-test/multi'], titleGuess: 'Multi', artistGuess: 'Artist',
      state: 'matched', releaseId: testReleaseId, trackCount: 2, discCount: 2,
    });

    const file1 = randomUUID();
    const file2 = randomUUID();
    await db.insert(audioFiles).values([
      { id: file1, libraryId, scanRootId: rootId, relPath: 'multi/1-01.mp3', sizeBytes: 1, mtime: 1, status: 'present', tagsRaw: {} },
      { id: file2, libraryId, scanRootId: rootId, relPath: 'multi/2-01.mp3', sizeBytes: 1, mtime: 1, status: 'present', tagsRaw: {} },
    ]);

    const lt1 = randomUUID();
    const lt2 = randomUUID();
    await db.insert(localTracks).values([
      { id: lt1, localAlbumId: album2Id, audioFileId: file1, discNo: 1, trackNo: 1, titleGuess: 'Disc1Track1', durationMs: 180000 },
      { id: lt2, localAlbumId: album2Id, audioFileId: file2, discNo: 2, trackNo: 1, titleGuess: 'Disc2Track1', durationMs: 200000 },
    ]);

    const ct1 = randomUUID();
    const ct2 = randomUUID();
    await db.insert(canonicalTracks).values([
      { id: ct1, releaseId: testReleaseId, mediumNo: 1, position: 1, number: '1', title: 'Disc1Track1', artistCredit: [], lengthMs: 180000 },
      { id: ct2, releaseId: testReleaseId, mediumNo: 2, position: 1, number: '1', title: 'Disc2Track1', artistCredit: [], lengthMs: 200000 },
    ]);

    const result = await linkAlbumTracks(ctx, album2Id);

    expect(result?.linked).toBe(2);
    expect(result?.unaligned).toBe(0);

    await db.delete(localTracks).where(eq(localTracks.localAlbumId, album2Id));
    await db.delete(audioFiles).where(eq(audioFiles.libraryId, libraryId));
    await db.delete(localAlbums).where(eq(localAlbums.id, album2Id));
    await db.delete(canonicalTracks).where(eq(canonicalTracks.releaseId, testReleaseId));
    await db.delete(releases).where(eq(releases.id, testReleaseId));
  });

  it('should leave unmatched tracks unlinked and mark album as linked', async () => {
    const album3Id = randomUUID();
    const testReleaseId = randomUUID();
    await db.insert(releases).values({
      id: testReleaseId, releaseGroupId, mbid: 'link-rel-partial', title: 'Partial Album',
    });

    await db.insert(localAlbums).values({
      id: album3Id, libraryId, clusterKey: `partial-${album3Id}`, dirPaths: ['/link-test/partial'], titleGuess: 'Partial', artistGuess: 'Artist',
      state: 'matched', releaseId: testReleaseId, trackCount: 3, discCount: 1,
    });

    const file1 = randomUUID();
    const file2 = randomUUID();
    const file3 = randomUUID();
    await db.insert(audioFiles).values([
      { id: file1, libraryId, scanRootId: rootId, relPath: 'partial/01.mp3', sizeBytes: 1, mtime: 1, status: 'present', tagsRaw: {} },
      { id: file2, libraryId, scanRootId: rootId, relPath: 'partial/02.mp3', sizeBytes: 1, mtime: 1, status: 'present', tagsRaw: {} },
      { id: file3, libraryId, scanRootId: rootId, relPath: 'partial/extra.mp3', sizeBytes: 1, mtime: 1, status: 'present', tagsRaw: {} },
    ]);

    const lt1 = randomUUID();
    const lt2 = randomUUID();
    const lt3 = randomUUID();
    await db.insert(localTracks).values([
      { id: lt1, localAlbumId: album3Id, audioFileId: file1, discNo: null, trackNo: 1, titleGuess: 'Track 1', durationMs: 180000 },
      { id: lt2, localAlbumId: album3Id, audioFileId: file2, discNo: null, trackNo: 2, titleGuess: 'Track 2', durationMs: 200000 },
      { id: lt3, localAlbumId: album3Id, audioFileId: file3, discNo: null, trackNo: 3, titleGuess: 'Extra Track', durationMs: 150000 },
    ]);

    const ct1 = randomUUID();
    const ct2 = randomUUID();
    await db.insert(canonicalTracks).values([
      { id: ct1, releaseId: testReleaseId, mediumNo: 1, position: 1, number: '1', title: 'Track 1', artistCredit: [], lengthMs: 180000 },
      { id: ct2, releaseId: testReleaseId, mediumNo: 1, position: 2, number: '2', title: 'Track 2', artistCredit: [], lengthMs: 200000 },
    ]);

    const result = await linkAlbumTracks(ctx, album3Id);

    expect(result?.linked).toBe(2);
    expect(result?.unaligned).toBe(1);

    const album = (await db.select().from(localAlbums).where(eq(localAlbums.id, album3Id)))[0];
    expect(album?.tracksLinkedAt).not.toBeNull();

    const unlinkedTrack = (await db.select().from(localTracks).where(eq(localTracks.id, lt3)))[0];
    expect(unlinkedTrack?.canonicalTrackId).toBeNull();
    expect(unlinkedTrack?.state).toBe('unmatched');

    await db.delete(localTracks).where(eq(localTracks.localAlbumId, album3Id));
    await db.delete(audioFiles).where(eq(audioFiles.libraryId, libraryId));
    await db.delete(localAlbums).where(eq(localAlbums.id, album3Id));
    await db.delete(canonicalTracks).where(eq(canonicalTracks.releaseId, testReleaseId));
    await db.delete(releases).where(eq(releases.id, testReleaseId));
  });

  it('should be idempotent and re-link with same ids after canonical re-fetch', async () => {
    const album4Id = randomUUID();
    const testReleaseId = randomUUID();
    await db.insert(releases).values({
      id: testReleaseId, releaseGroupId, mbid: 'link-rel-idem', title: 'Idempotent Album',
    });

    await db.insert(localAlbums).values({
      id: album4Id, libraryId, clusterKey: `idem-${album4Id}`, dirPaths: ['/link-test/idem'], titleGuess: 'Idempotent', artistGuess: 'Artist',
      state: 'matched', releaseId: testReleaseId, trackCount: 2, discCount: 1,
    });

    const file1 = randomUUID();
    const file2 = randomUUID();
    await db.insert(audioFiles).values([
      { id: file1, libraryId, scanRootId: rootId, relPath: 'idem/01.mp3', sizeBytes: 1, mtime: 1, status: 'present', tagsRaw: {} },
      { id: file2, libraryId, scanRootId: rootId, relPath: 'idem/02.mp3', sizeBytes: 1, mtime: 1, status: 'present', tagsRaw: {} },
    ]);

    const lt1 = randomUUID();
    const lt2 = randomUUID();
    await db.insert(localTracks).values([
      { id: lt1, localAlbumId: album4Id, audioFileId: file1, discNo: null, trackNo: 1, titleGuess: 'Track 1', durationMs: 180000 },
      { id: lt2, localAlbumId: album4Id, audioFileId: file2, discNo: null, trackNo: 2, titleGuess: 'Track 2', durationMs: 200000 },
    ]);

    const ct1 = randomUUID();
    const ct2 = randomUUID();
    await db.insert(canonicalTracks).values([
      { id: ct1, releaseId: testReleaseId, mediumNo: 1, position: 1, number: '1', title: 'Track 1', artistCredit: [], lengthMs: 180000 },
      { id: ct2, releaseId: testReleaseId, mediumNo: 1, position: 2, number: '2', title: 'Track 2', artistCredit: [], lengthMs: 200000 },
    ]);

    const result1 = await linkAlbumTracks(ctx, album4Id);
    const track1a = (await db.select().from(localTracks).where(eq(localTracks.id, lt1)))[0];
    const linkedId1a = track1a?.canonicalTrackId;

    // Simulate re-fetch: update canonical tracks while keeping same (release, medium, position)
    await db.update(canonicalTracks)
      .set({ title: 'Track 1 (Updated)' })
      .where(eq(canonicalTracks.id, ct1));

    // Re-link the same album
    const result2 = await linkAlbumTracks(ctx, album4Id);

    const track1b = (await db.select().from(localTracks).where(eq(localTracks.id, lt1)))[0];
    const linkedId1b = track1b?.canonicalTrackId;

    // IDs should remain the same (stable upsert)
    expect(linkedId1a).toBe(linkedId1b);
    expect(linkedId1a).toBe(ct1);

    await db.delete(localTracks).where(eq(localTracks.localAlbumId, album4Id));
    await db.delete(audioFiles).where(eq(audioFiles.libraryId, libraryId));
    await db.delete(localAlbums).where(eq(localAlbums.id, album4Id));
    await db.delete(canonicalTracks).where(eq(canonicalTracks.releaseId, testReleaseId));
    await db.delete(releases).where(eq(releases.id, testReleaseId));
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('fillTrackIdsFromCache (db)', () => {
  let ctx: WorkerContext;
  let db: any;
  let client: any;
  let userId: string;
  let libraryId: string;
  let releaseId: string;
  let releaseGroupId: string;

  beforeAll(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL not set');
    const made = await makeDb(databaseUrl);
    db = made.db;
    client = made.client;
    ctx = { db: made.db, sql: made.client, boss: {} as any, logger: pino({ level: 'silent' }) };

    userId = randomUUID();
    await db.insert(users).values({ id: userId, email: `filltest-${userId}@test.com`, passwordHash: 'x' });

    libraryId = randomUUID();
    await db.insert(libraries).values({ id: libraryId, name: 'FillTest', ownerUserId: userId });

    releaseGroupId = randomUUID();
    await db.insert(releaseGroups).values({
      id: releaseGroupId, mbid: 'fill-rg-1', title: 'Fill Test', artistCredit: [],
    });

    releaseId = randomUUID();
    await db.insert(releases).values({
      id: releaseId, releaseGroupId, mbid: 'fill-rel-1', title: 'Fill Test',
    });
  });

  afterAll(async () => {
    await db.delete(canonicalTracks).where(eq(canonicalTracks.releaseId, releaseId));
    await db.delete(providerCache).where(eq(providerCache.provider, 'musicbrainz'));
    await db.delete(releases).where(eq(releases.id, releaseId));
    await db.delete(releaseGroups).where(eq(releaseGroups.id, releaseGroupId));
    await db.delete(libraries).where(eq(libraries.id, libraryId));
    await db.delete(users).where(eq(users.id, userId));
    await client.end({ timeout: 5 });
  });

  it('should fill recording_mbid and track_mbid from provider_cache', async () => {
    const ct1 = randomUUID();
    const ct2 = randomUUID();
    await db.insert(canonicalTracks).values([
      { id: ct1, releaseId, mediumNo: 1, position: 1, number: '1', title: 'Track 1', artistCredit: [] },
      { id: ct2, releaseId, mediumNo: 1, position: 2, number: '2', title: 'Track 2', artistCredit: [] },
    ]);

    const payload: CanonicalRelease = {
      id: 'fill-rel-1',
      source: 'musicbrainz',
      title: 'Fill Test',
      releaseGroupId: 'fill-rg-1',
      artists: [],
      tracks: [
        {
          title: 'Track 1',
          artists: [],
          duration: 180000,
          position: 1,
          mediumNumber: 1,
          recordingId: 'rec-1-uuid',
          trackId: 'track-1-uuid',
        },
        {
          title: 'Track 2',
          artists: [],
          duration: 200000,
          position: 2,
          mediumNumber: 1,
          recordingId: 'rec-2-uuid',
          trackId: 'track-2-uuid',
        },
      ],
    };

    await db.insert(providerCache).values({
      provider: 'musicbrainz',
      cacheKey: 'v2:release:fill-rel-1',
      payload,
      expiresAt: new Date(Date.now() + 86400000),
    });

    const result = await fillTrackIdsFromCache(ctx, releaseId);

    expect(result?.filled).toBe(2);

    const track1 = (await db.select().from(canonicalTracks).where(eq(canonicalTracks.id, ct1)))[0];
    expect(track1?.recordingMbid).toBe('rec-1-uuid');
    expect(track1?.trackMbid).toBe('track-1-uuid');

    const track2 = (await db.select().from(canonicalTracks).where(eq(canonicalTracks.id, ct2)))[0];
    expect(track2?.recordingMbid).toBe('rec-2-uuid');
    expect(track2?.trackMbid).toBe('track-2-uuid');
  });

  it('should not overwrite existing mbids with null', async () => {
    const ct3 = randomUUID();
    await db.insert(canonicalTracks).values({
      id: ct3, releaseId, mediumNo: 1, position: 3, number: '3', title: 'Track 3', artistCredit: [],
      recordingMbid: 'existing-rec-3', trackMbid: 'existing-track-3',
    });

    const payload: CanonicalRelease = {
      id: 'fill-rel-1',
      source: 'musicbrainz',
      title: 'Fill Test',
      releaseGroupId: 'fill-rg-1',
      artists: [],
      tracks: [
        {
          title: 'Track 3',
          artists: [],
          duration: 220000,
          position: 3,
          mediumNumber: 1,
          // No recordingId or trackId in this payload
        },
      ],
    };

    await db.delete(providerCache).where(eq(providerCache.provider, 'musicbrainz'));
    await db.insert(providerCache).values({
      provider: 'musicbrainz',
      cacheKey: 'v2:release:fill-rel-1',
      payload,
      expiresAt: new Date(Date.now() + 86400000),
    });

    const result = await fillTrackIdsFromCache(ctx, releaseId);

    expect(result?.filled).toBe(0); // No updates because track already has ids

    const track3 = (await db.select().from(canonicalTracks).where(eq(canonicalTracks.id, ct3)))[0];
    expect(track3?.recordingMbid).toBe('existing-rec-3');
    expect(track3?.trackMbid).toBe('existing-track-3');
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('tracksLinkJob sweep (db)', () => {
  let ctx: WorkerContext;
  let db: any;
  let client: any;
  let userId: string;
  let libraryId: string;
  let rootId: string;
  let releaseGroupId: string;

  beforeAll(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL not set');
    const made = await makeDb(databaseUrl);
    db = made.db;
    client = made.client;
    ctx = { db: made.db, sql: made.client, boss: {} as any, logger: pino({ level: 'silent' }) };

    userId = randomUUID();
    await db.insert(users).values({ id: userId, email: `sweeptest-${userId}@test.com`, passwordHash: 'x' });

    libraryId = randomUUID();
    await db.insert(libraries).values({ id: libraryId, name: 'SweepTest', ownerUserId: userId });

    rootId = randomUUID();
    await db.insert(scanRoots).values({ id: rootId, libraryId, path: '/sweep-test', displayName: 'SweepTest', writable: true });

    releaseGroupId = randomUUID();
    await db.insert(releaseGroups).values({
      id: releaseGroupId, mbid: 'sweep-rg-1', title: 'Sweep Test', artistCredit: [],
    });
  });

  afterAll(async () => {
    // Cleanup in reverse order of creation
    await db.delete(localTracks).where(eq(localTracks.id, localTracks.id)); // simplified cleanup
    await db.delete(audioFiles).where(eq(audioFiles.libraryId, libraryId));
    await db.delete(localAlbums).where(eq(localAlbums.libraryId, libraryId));
    await db.delete(canonicalTracks).where(eq(canonicalTracks.id, canonicalTracks.id)); // simplified cleanup
    await db.delete(releases).where(eq(releases.id, releases.id)); // simplified cleanup
    await db.delete(scanRoots).where(eq(scanRoots.id, rootId));
    await db.delete(libraries).where(eq(libraries.id, libraryId));
    await db.delete(users).where(eq(users.id, userId));
    await client.end({ timeout: 5 });
  });

  it('should link only albums with null tracks_linked_at and skip already-linked ones', async () => {
    // Import tracksLinkJob from the job module
    const { tracksLinkJob } = await import('../jobs/tracksLink.js');

    // Create multiple releases
    const rel1Id = randomUUID();
    const rel2Id = randomUUID();
    await db.insert(releases).values([
      { id: rel1Id, releaseGroupId, mbid: 'sweep-rel-1', title: 'Sweep Album 1' },
      { id: rel2Id, releaseGroupId, mbid: 'sweep-rel-2', title: 'Sweep Album 2' },
    ]);

    // Create canonical tracks for both releases (with trackMbid set to skip ensureTrackMbids)
    const ct1a = randomUUID();
    const ct1b = randomUUID();
    const ct2a = randomUUID();
    await db.insert(canonicalTracks).values([
      { id: ct1a, releaseId: rel1Id, mediumNo: 1, position: 1, number: '1', title: 'Track 1', artistCredit: [], lengthMs: 180000, trackMbid: 'tm-1a' },
      { id: ct1b, releaseId: rel1Id, mediumNo: 1, position: 2, number: '2', title: 'Track 2', artistCredit: [], lengthMs: 200000, trackMbid: 'tm-1b' },
      { id: ct2a, releaseId: rel2Id, mediumNo: 1, position: 1, number: '1', title: 'Track 1', artistCredit: [], lengthMs: 180000, trackMbid: 'tm-2a' },
    ]);

    // Create albums: one unlinked (tracks_linked_at is null), one already linked (with tracksLinkedAt)
    const album1Id = randomUUID();
    const album2Id = randomUUID();
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86400000);

    await db.insert(localAlbums).values([
      {
        id: album1Id, libraryId, clusterKey: `sweep-unlinked-${album1Id}`, dirPaths: ['/sweep-test/1'],
        titleGuess: 'Unlinked', artistGuess: 'Artist', state: 'matched', releaseId: rel1Id,
        trackCount: 2, discCount: 1, identifiedAt: now, tracksLinkedAt: null, // UNLINKED
      },
      {
        id: album2Id, libraryId, clusterKey: `sweep-linked-${album2Id}`, dirPaths: ['/sweep-test/2'],
        titleGuess: 'Linked', artistGuess: 'Artist', state: 'matched', releaseId: rel2Id,
        trackCount: 1, discCount: 1, identifiedAt: yesterday, tracksLinkedAt: yesterday, // ALREADY LINKED
      },
    ]);

    // Create audio files and local tracks
    const file1a = randomUUID();
    const file1b = randomUUID();
    const file2a = randomUUID();
    await db.insert(audioFiles).values([
      { id: file1a, libraryId, scanRootId: rootId, relPath: 'sweep/1/01.mp3', sizeBytes: 1, mtime: 1, status: 'present', tagsRaw: {} },
      { id: file1b, libraryId, scanRootId: rootId, relPath: 'sweep/1/02.mp3', sizeBytes: 1, mtime: 1, status: 'present', tagsRaw: {} },
      { id: file2a, libraryId, scanRootId: rootId, relPath: 'sweep/2/01.mp3', sizeBytes: 1, mtime: 1, status: 'present', tagsRaw: {} },
    ]);

    const lt1a = randomUUID();
    const lt1b = randomUUID();
    const lt2a = randomUUID();
    await db.insert(localTracks).values([
      { id: lt1a, localAlbumId: album1Id, audioFileId: file1a, discNo: null, trackNo: 1, titleGuess: 'Track 1', durationMs: 180000 },
      { id: lt1b, localAlbumId: album1Id, audioFileId: file1b, discNo: null, trackNo: 2, titleGuess: 'Track 2', durationMs: 200000 },
      { id: lt2a, localAlbumId: album2Id, audioFileId: file2a, discNo: null, trackNo: 1, titleGuess: 'Track 1', durationMs: 180000 },
    ]);

    // Call sweep
    await tracksLinkJob(ctx, { sweep: true, limit: 10 });

    // Verify: unlinked album should now be linked
    const album1After = (await db.select().from(localAlbums).where(eq(localAlbums.id, album1Id)))[0];
    expect(album1After?.tracksLinkedAt).not.toBeNull();

    const track1aAfter = (await db.select().from(localTracks).where(eq(localTracks.id, lt1a)))[0];
    expect(track1aAfter?.canonicalTrackId).toBe(ct1a);
    expect(track1aAfter?.state).toBe('matched');

    // Verify: already-linked album should remain unchanged
    const album2After = (await db.select().from(localAlbums).where(eq(localAlbums.id, album2Id)))[0];
    expect(album2After?.tracksLinkedAt?.getTime()).toBe(yesterday.getTime());

    // Cleanup
    await db.delete(localTracks).where(eq(localTracks.localAlbumId, album1Id));
    await db.delete(localTracks).where(eq(localTracks.localAlbumId, album2Id));
    await db.delete(audioFiles).where(eq(audioFiles.libraryId, libraryId));
    await db.delete(localAlbums).where(eq(localAlbums.libraryId, libraryId));
    await db.delete(canonicalTracks).where(eq(canonicalTracks.releaseId, rel1Id));
    await db.delete(canonicalTracks).where(eq(canonicalTracks.releaseId, rel2Id));
    await db.delete(releases).where(eq(releases.id, rel1Id));
    await db.delete(releases).where(eq(releases.id, rel2Id));
  });
});

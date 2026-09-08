/**
 * Tests for gaps.recompute job handler - specifically GAP-2 missing_album gaps
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import {
  users,
  libraries,
  artists,
  releaseGroups,
  releaseGroupArtists,
  localAlbums,
  followedArtists,
  gaps,
} from '@liner/db';
import { makeDb } from '@liner/db';
import type { WorkerContext } from '../lib/context.js';
import { gapsRecomputeJob, type GapsRecomputeJobData } from './gapsRecompute.js';
import pino from 'pino';

const hasDatabaseUrl = !!(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);

describe.skipIf(!hasDatabaseUrl)('gapsRecomputeJob - missing_album gaps', () => {
  let ctx: WorkerContext;
  let db: any;
  let userId: string;
  let libraryId: string;
  let artistId: string;
  let releaseGroupId1: string;
  let releaseGroupId2: string;
  let releaseGroupId3: string;

  beforeAll(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL or TEST_DATABASE_URL not set');
    }

    const { db: dbInstance, client } = await makeDb(databaseUrl);
    db = dbInstance;
    ctx = {
      db: dbInstance,
      sql: client,
      boss: null as any,
      logger: pino({ level: 'silent' }),
    };

    // Create test user
    userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `test-${userId}@test.com`,
      passwordHash: 'test-hash',
      createdAt: new Date(),
    });

    // Create test library
    libraryId = randomUUID();
    await db.insert(libraries).values({
      id: libraryId,
      name: 'Test Library',
      ownerUserId: userId,
      createdAt: new Date(),
    });

    // Create test artist
    artistId = randomUUID();
    await db.insert(artists).values({
      id: artistId,
      mbid: randomUUID(),
      name: 'Test Artist',
      createdAt: new Date(),
    });

    // Create release groups
    releaseGroupId1 = randomUUID();
    releaseGroupId2 = randomUUID();
    releaseGroupId3 = randomUUID();

    await db.insert(releaseGroups).values([
      {
        id: releaseGroupId1,
        mbid: randomUUID(),
        title: 'Album One',
        primaryType: 'Album',
      },
      {
        id: releaseGroupId2,
        mbid: randomUUID(),
        title: 'Album Two',
        primaryType: 'Album',
      },
      {
        id: releaseGroupId3,
        mbid: randomUUID(),
        title: 'Album Three',
        primaryType: 'EP',
      },
    ]);

    // Link artist to release groups
    await db.insert(releaseGroupArtists).values([
      {
        releaseGroupId: releaseGroupId1,
        artistId,
        position: 0,
      },
      {
        releaseGroupId: releaseGroupId2,
        artistId,
        position: 0,
      },
      {
        releaseGroupId: releaseGroupId3,
        artistId,
        position: 0,
      },
    ]);

    // Follow the artist
    await db.insert(followedArtists).values({
      libraryId,
      artistId,
      mode: 'manual',
      createdAt: new Date(),
    });
  });

  afterAll(async () => {
    // Cleanup
    await db.delete(gaps).where(eq(gaps.libraryId, libraryId));
    await db.delete(localAlbums).where(eq(localAlbums.libraryId, libraryId));
    await db.delete(releaseGroupArtists).where(eq(releaseGroupArtists.artistId, artistId));
    await db.delete(releaseGroups);
    await db.delete(followedArtists).where(eq(followedArtists.libraryId, libraryId));
    await db.delete(artists).where(eq(artists.id, artistId));
    await db.delete(libraries).where(eq(libraries.id, libraryId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it('should create missing_album gaps for release groups not owned locally', async () => {
    // Initially, no local albums exist, so all 3 release groups should get missing_album gaps
    const data: GapsRecomputeJobData = { libraryId };
    await gapsRecomputeJob(ctx, data);

    const missingGaps = await db
      .select()
      .from(gaps)
      .where(
        and(
          eq(gaps.libraryId, libraryId),
          eq(gaps.kind, 'missing_album'),
          eq(gaps.state, 'open')
        )
      );

    expect(missingGaps).toHaveLength(3);

    // Verify details contain title and primaryType
    const gap1 = missingGaps.find((g: any) => g.subjectId === releaseGroupId1);
    expect(gap1).toBeDefined();
    expect(gap1?.details).toEqual({ title: 'Album One', primaryType: 'Album' });

    const gap2 = missingGaps.find((g: any) => g.subjectId === releaseGroupId2);
    expect(gap2).toBeDefined();
    expect(gap2?.details).toEqual({ title: 'Album Two', primaryType: 'Album' });

    const gap3 = missingGaps.find((g: any) => g.subjectId === releaseGroupId3);
    expect(gap3).toBeDefined();
    expect(gap3?.details).toEqual({ title: 'Album Three', primaryType: 'EP' });
  });

  it('should persist dismissed gaps across recompute cycles', async () => {
    // First recompute to create gaps
    let data: GapsRecomputeJobData = { libraryId };
    await gapsRecomputeJob(ctx, data);

    // Dismiss one gap
    await db
      .update(gaps)
      .set({
        state: 'dismissed',
        dismissReason: 'wrong_data',
      })
      .where(eq(gaps.subjectId, releaseGroupId1));

    // Run recompute again
    await gapsRecomputeJob(ctx, data);

    // The dismissed gap should still be dismissed
    const dismissedGap = await db
      .select()
      .from(gaps)
      .where(
        and(
          eq(gaps.libraryId, libraryId),
          eq(gaps.subjectId, releaseGroupId1),
          eq(gaps.kind, 'missing_album')
        )
      )
      .limit(1);

    expect(dismissedGap[0]).toBeDefined();
    expect(dismissedGap[0]?.state).toBe('dismissed');
    expect(dismissedGap[0]?.dismissReason).toBe('wrong_data');
  });

  it('should transition gaps to resolved when release group becomes owned', async () => {
    // First recompute to create gaps
    let data: GapsRecomputeJobData = { libraryId };
    await gapsRecomputeJob(ctx, data);

    // Create a local album for releaseGroupId1
    const localAlbumId = randomUUID();
    await db.insert(localAlbums).values({
      id: localAlbumId,
      libraryId,
      clusterKey: 'test-cluster-1',
      state: 'matched',
      releaseGroupId: releaseGroupId1,
      trackCount: 10,
      discCount: 1,
      createdAt: new Date(),
    });

    // Run recompute again
    await gapsRecomputeJob(ctx, data);

    // The gap for releaseGroupId1 should be resolved
    const resolvedGap = await db
      .select()
      .from(gaps)
      .where(
        and(
          eq(gaps.libraryId, libraryId),
          eq(gaps.subjectId, releaseGroupId1),
          eq(gaps.kind, 'missing_album')
        )
      )
      .limit(1);

    expect(resolvedGap[0]).toBeDefined();
    expect(resolvedGap[0]?.state).toBe('resolved');
    expect(resolvedGap[0]?.resolvedAt).toBeDefined();

    // The other gaps should still be open
    const openGaps = await db
      .select()
      .from(gaps)
      .where(
        and(
          eq(gaps.libraryId, libraryId),
          eq(gaps.kind, 'missing_album'),
          eq(gaps.state, 'open')
        )
      );

    expect(openGaps).toHaveLength(2);
  });

  it('should use natural key upsert to prevent duplicate gaps', async () => {
    // Run recompute twice without changes
    const data: GapsRecomputeJobData = { libraryId };

    // Clear existing gaps first
    await db.delete(gaps).where(eq(gaps.libraryId, libraryId));

    await gapsRecomputeJob(ctx, data);
    const countAfterFirst = await db
      .select()
      .from(gaps)
      .where(
        and(
          eq(gaps.libraryId, libraryId),
          eq(gaps.kind, 'missing_album')
        )
      );

    await gapsRecomputeJob(ctx, data);
    const countAfterSecond = await db
      .select()
      .from(gaps)
      .where(
        and(
          eq(gaps.libraryId, libraryId),
          eq(gaps.kind, 'missing_album')
        )
      );

    // Same number of gaps - no duplicates
    expect(countAfterFirst).toHaveLength(2); // releaseGroupId2 and Id3, since Id1 is owned
    expect(countAfterSecond).toHaveLength(2);
  });

  it('should handle mark-and-sweep pattern correctly', async () => {
    // Clear all gaps
    await db.delete(gaps).where(eq(gaps.libraryId, libraryId));

    // First run: create gaps for all unowned release groups
    let data: GapsRecomputeJobData = { libraryId };
    await gapsRecomputeJob(ctx, data);

    let allGaps = await db
      .select()
      .from(gaps)
      .where(
        and(
          eq(gaps.libraryId, libraryId),
          eq(gaps.kind, 'missing_album')
        )
      );
    expect(allGaps).toHaveLength(2); // releaseGroupId2 and Id3, since Id1 is owned

    // Add ownership for releaseGroupId2
    const localAlbumId2 = randomUUID();
    await db.insert(localAlbums).values({
      id: localAlbumId2,
      libraryId,
      clusterKey: 'test-cluster-2',
      state: 'matched',
      releaseGroupId: releaseGroupId2,
      trackCount: 12,
      discCount: 1,
      createdAt: new Date(),
    });

    // Run recompute - should resolve the gap for releaseGroupId2
    await gapsRecomputeJob(ctx, data);

    allGaps = await db
      .select()
      .from(gaps)
      .where(
        and(
          eq(gaps.libraryId, libraryId),
          eq(gaps.kind, 'missing_album')
        )
      );

    // Should have one resolved and one open
    const resolved = allGaps.filter((g: any) => g.state === 'resolved');
    const open = allGaps.filter((g: any) => g.state === 'open');

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.subjectId).toBe(releaseGroupId2);
    expect(open).toHaveLength(1);
    expect(open[0]?.subjectId).toBe(releaseGroupId3);
  });

  it('should correctly identify release groups through release_group_artists', async () => {
    // Create a new artist and release group
    const newArtistId = randomUUID();
    const newRgId = randomUUID();

    await db.insert(artists).values({
      id: newArtistId,
      mbid: randomUUID(),
      name: 'Another Artist',
      createdAt: new Date(),
    });

    await db.insert(releaseGroups).values({
      id: newRgId,
      mbid: randomUUID(),
      title: 'Another Album',
      primaryType: 'Single',
    });

    await db.insert(releaseGroupArtists).values({
      releaseGroupId: newRgId,
      artistId: newArtistId,
      position: 0,
    });

    // Follow the new artist
    await db.insert(followedArtists).values({
      libraryId,
      artistId: newArtistId,
      mode: 'auto',
      createdAt: new Date(),
    });

    // Run recompute
    const data: GapsRecomputeJobData = { libraryId };
    await gapsRecomputeJob(ctx, data);

    // The new release group should have a missing_album gap
    const newGap = await db
      .select()
      .from(gaps)
      .where(
        and(
          eq(gaps.libraryId, libraryId),
          eq(gaps.subjectId, newRgId),
          eq(gaps.kind, 'missing_album')
        )
      )
      .limit(1);

    expect(newGap[0]).toBeDefined();
    expect(newGap[0]?.details).toEqual({
      title: 'Another Album',
      primaryType: 'Single',
    });

    // Cleanup
    await db.delete(followedArtists).where(eq(followedArtists.artistId, newArtistId));
    await db.delete(releaseGroupArtists).where(eq(releaseGroupArtists.artistId, newArtistId));
    await db.delete(releaseGroups).where(eq(releaseGroups.id, newRgId));
    await db.delete(artists).where(eq(artists.id, newArtistId));
  });
});

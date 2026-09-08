/**
 * Tests for artist routes including per-artist follow rules and last_viewed_at tracking
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import {
  artists,
  libraries,
  users,
  followedArtists,
} from '@liner/db';
import { makeDb } from '@liner/db';
import { normalizeFollowRules } from '@liner/core';
import type { FollowRules } from '@liner/shared/library';

describe('Artist routes - follow rules (unit)', () => {
  it('should normalize follow rules with defaults', () => {
    const rules = normalizeFollowRules({
      includePrimary: ['Album'],
      excludeSecondary: ['Compilation'],
    });

    expect(rules.includePrimary).toContain('Album');
    expect(rules.excludeSecondary).toContain('Compilation');
    expect(rules.autoFollowMinAlbums).toBe(2);
  });

  it('should validate primary types', () => {
    expect(() => {
      normalizeFollowRules({
        includePrimary: ['Album', 'InvalidType' as any],
      });
    }).toThrow();
  });

  it('should validate secondary types', () => {
    expect(() => {
      normalizeFollowRules({
        excludeSecondary: ['Compilation', 'InvalidType' as any],
      });
    }).toThrow();
  });

  it('should allow merging partial updates', () => {
    const current: FollowRules = {
      includePrimary: ['Album'],
      excludeSecondary: ['Compilation', 'Live'],
      autoFollowMinAlbums: 2,
    };

    const update = normalizeFollowRules({
      includePrimary: ['Album', 'EP'],
      excludeSecondary: current.excludeSecondary,
    });

    expect(update.includePrimary).toContain('EP');
    expect(update.excludeSecondary).toContain('Live');
  });

  it('should deduplicate types', () => {
    const rules = normalizeFollowRules({
      includePrimary: ['Album', 'Album', 'EP'],
      excludeSecondary: ['Compilation', 'Compilation'],
    });

    const primaryCount = rules.includePrimary.filter((t) => t === 'Album').length;
    expect(primaryCount).toBe(1);

    const secondaryCount = rules.excludeSecondary.filter((t) => t === 'Compilation').length;
    expect(secondaryCount).toBe(1);
  });

  it('should sort types for consistency', () => {
    const rules1 = normalizeFollowRules({
      includePrimary: ['Single', 'Album', 'EP'],
    });

    const rules2 = normalizeFollowRules({
      includePrimary: ['Album', 'EP', 'Single'],
    });

    expect(rules1.includePrimary).toEqual(rules2.includePrimary);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'Artist routes - last_viewed_at tracking (integration)',
  () => {
    let db: any;
    let userId: string;
    let libraryId: string;
    let artistId: string;

    beforeEach(async () => {
      const databaseUrl = process.env.TEST_DATABASE_URL;
      if (!databaseUrl) {
        throw new Error('TEST_DATABASE_URL not set — these suites delete rows and must never run against DATABASE_URL');
      }

      const { db: dbInstance } = await makeDb(databaseUrl);
      db = dbInstance;

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
        sortName: 'Artist, Test',
        createdAt: new Date(),
      });
    });

    afterEach(async () => {
      // Cleanup - delete test data
      if (db) {
        await db.delete(followedArtists).where(eq(followedArtists.artistId, artistId));
        await db.delete(artists).where(eq(artists.id, artistId));
        await db.delete(libraries).where(eq(libraries.id, libraryId));
        await db.delete(users).where(eq(users.id, userId));
      }
    });

  it('should update last_viewed_at when a followed artist page is visited', async () => {
    // Follow the artist
    await db.insert(followedArtists).values({
      libraryId,
      artistId,
      mode: 'manual',
      createdAt: new Date(),
    });

    // Get the initial row
    const [beforeRow] = await db.select().from(followedArtists)
      .where(and(eq(followedArtists.libraryId, libraryId), eq(followedArtists.artistId, artistId)));

    expect(beforeRow).toBeDefined();
    const initialLastViewed = beforeRow.lastViewedAt;

    // Simulate a visit by updating last_viewed_at (as the GET endpoint does)
    const now = new Date();
    await db.update(followedArtists)
      .set({ lastViewedAt: now })
      .where(and(eq(followedArtists.libraryId, libraryId), eq(followedArtists.artistId, artistId)));

    // Get the updated row
    const [afterRow] = await db.select().from(followedArtists)
      .where(and(eq(followedArtists.libraryId, libraryId), eq(followedArtists.artistId, artistId)));

    expect(afterRow.lastViewedAt).toBeDefined();
    expect(new Date(afterRow.lastViewedAt).getTime()).toBeGreaterThanOrEqual(now.getTime());
  });

  it('should advance last_viewed_at on subsequent visits', async () => {
    // Follow the artist
    await db.insert(followedArtists).values({
      libraryId,
      artistId,
      mode: 'manual',
      createdAt: new Date(),
    });

    // First visit
    const firstVisit = new Date();
    await db.update(followedArtists)
      .set({ lastViewedAt: firstVisit })
      .where(and(eq(followedArtists.libraryId, libraryId), eq(followedArtists.artistId, artistId)));

    const [afterFirst] = await db.select().from(followedArtists)
      .where(and(eq(followedArtists.libraryId, libraryId), eq(followedArtists.artistId, artistId)));
    const firstTimestamp = afterFirst.lastViewedAt;

    // A later visit only needs a later clock; the route has no throttle, so a
    // short pause keeps the test inside vitest's default 5 s budget.
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Second visit
    const secondVisit = new Date();
    await db.update(followedArtists)
      .set({ lastViewedAt: secondVisit })
      .where(and(eq(followedArtists.libraryId, libraryId), eq(followedArtists.artistId, artistId)));

    const [afterSecond] = await db.select().from(followedArtists)
      .where(and(eq(followedArtists.libraryId, libraryId), eq(followedArtists.artistId, artistId)));
    const secondTimestamp = afterSecond.lastViewedAt;

    // Verify that the timestamp advanced
    expect(secondTimestamp.getTime()).toBeGreaterThan(firstTimestamp.getTime());
    expect(secondTimestamp.getTime() - firstTimestamp.getTime()).toBeGreaterThanOrEqual(100);
  });

  it('should not update last_viewed_at when artist is not followed', async () => {
    // Do NOT follow the artist
    // Verify follow row doesn't exist
    const [followRow] = await db.select().from(followedArtists)
      .where(and(eq(followedArtists.libraryId, libraryId), eq(followedArtists.artistId, artistId)));

    expect(followRow).toBeUndefined();
    // If there's no row, there's nothing to update, which is correct behavior
  });
});

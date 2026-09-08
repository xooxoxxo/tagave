import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, and, inArray } from 'drizzle-orm';
import { type TagPolicies } from '@liner/shared';
import { metadataService, tagsPreviewJob } from './tagsPreview.js';
import {
  tagPlans,
  tagPlanItems,
  libraries,
  users,
  audioFiles,
  scanRoots,
} from '@liner/db';
import { makeDb } from '@liner/db';
import type { WorkerContext } from '../lib/context.js';
import pino from 'pino';

describe('tagsPreview job', () => {
  it('should have a working mock metadata service', async () => {
    const audioFileId = 'test-file-123';
    const metadata = { title: 'Test Title', artist: 'Test Artist' };

    metadataService.setFixture(audioFileId, metadata);
    const retrieved = await metadataService.getCanonicalMetadata(audioFileId);

    expect(retrieved).toEqual(metadata);
  });

  it('should accept valid tag policies', () => {
    const validPolicies: TagPolicies = {
      preset: 'canonical_ids_and_fill',
      id3Version: '2.4',
      multiValueSeparator: '; ',
    };

    expect(validPolicies.preset).toBe('canonical_ids_and_fill');
    expect(validPolicies.id3Version).toBe('2.4');
    expect(validPolicies.multiValueSeparator).toBe('; ');
  });

  it('should support policy overrides', () => {
    const policyWithOverrides: TagPolicies = {
      preset: 'custom',
      id3Version: '2.3',
      multiValueSeparator: ' / ',
      overrides: {
        title: 'fill',
        artist: 'overwrite',
      } as any,
    };

    expect(policyWithOverrides.overrides).toBeDefined();
    expect(policyWithOverrides.overrides?.title).toBe('fill');
  });

  // Integration test: ensure preview doesn't create duplicates when run multiple times
  describe('duplicate prevention (finding 1)', () => {
    let ctx: WorkerContext;
    let dbClient: any;
    let userId: string;
    let libraryId: string;
    let audioFileId: string;
    let planId: string;

    beforeAll(async () => {
      const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
      if (!databaseUrl) {
        throw new Error('DATABASE_URL or TEST_DATABASE_URL not set');
      }

      const { db, client } = await makeDb(databaseUrl);
      dbClient = db;
      ctx = {
        db,
        sql: client,
        boss: null as any,
        logger: pino({ level: 'silent' }),
      };

      // Setup: user, library, scan root, audio file
      userId = randomUUID();
      await db.insert(users).values({
        id: userId,
        email: `test-${userId}@test.com`,
        passwordHash: 'test-hash',
        createdAt: new Date(),
      });

      libraryId = randomUUID();
      await db.insert(libraries).values({
        id: libraryId,
        name: 'Test Library',
        ownerUserId: userId,
        settings: { tagWritesEnabled: true },
        createdAt: new Date(),
      });

      const scanRootId = randomUUID();
      await db.insert(scanRoots).values({
        id: scanRootId,
        libraryId,
        path: '/test/music',
        displayName: 'Test Root',
        writable: true,
        probeWritable: true,
        enabled: true,
        createdAt: new Date(),
      });

      audioFileId = randomUUID();
      await db.insert(audioFiles).values({
        id: audioFileId,
        libraryId,
        scanRootId,
        relPath: 'test.flac',
        sizeBytes: 10000,
        container: 'FLAC',
        codec: 'FLAC',
        lossless: true,
        durationMs: 180000,
        sampleRate: 44100,
        bitDepth: 16,
        channels: 2,
        status: 'present',
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      });

      // Set metadata fixture for this file
      metadataService.setFixture(audioFileId, {
        title: 'New Title',
        artist: 'New Artist',
      });

      planId = randomUUID();
      await db.insert(tagPlans).values({
        id: planId,
        libraryId,
        name: 'Test Plan',
        scope: { type: 'library' },
        policy: {
          preset: 'canonical_ids_and_fill',
          id3Version: '2.4',
          multiValueSeparator: '; ',
        },
        status: 'draft',
        stats: {},
        createdBy: userId,
        createdAt: new Date(),
      });
    });

    it('should delete pending items before recomputing (prevent duplicates)', async () => {
      // Run preview once
      await tagsPreviewJob(ctx, planId);

      const items1 = await dbClient
        .select()
        .from(tagPlanItems)
        .where(eq(tagPlanItems.tagPlanId, planId));

      const count1 = items1.length;
      expect(count1).toBeGreaterThan(0);

      // Run preview again - should delete pending items and recompute
      await tagsPreviewJob(ctx, planId);

      const items2 = await dbClient
        .select()
        .from(tagPlanItems)
        .where(eq(tagPlanItems.tagPlanId, planId));

      const count2 = items2.length;

      // Should have same count, not doubled
      expect(count2).toBe(count1);

      // All should be pending (not applying)
      for (const item of items2) {
        expect(item.status).toBe('pending');
      }
    });
  });
});

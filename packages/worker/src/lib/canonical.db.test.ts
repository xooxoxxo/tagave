/**
 * Database tests for canonical track stable upsert (0026).
 * Tests that track identity is stable across re-fetches and that mbids are preserved.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { canonicalTracks, releases, releaseGroups, makeDb } from '@liner/db';
import pino from 'pino';
import { canonicalTrackRows, upsertCanonical } from './canonical.js';
import type { CanonicalRelease, CanonicalTrack } from '@liner/core';
import type { WorkerContext } from './context.js';

describe('canonicalTrackRows', () => {
  it('should deduplicate by (mediumNo, position) keeping first occurrence', () => {
    const tracks: CanonicalTrack[] = [
      {
        title: 'Track 1',
        artists: ['Artist A'],
        duration: 180000,
        position: 1,
        mediumNumber: 1,
      },
      {
        title: 'Track 1 Dup',
        artists: ['Artist B'],
        duration: 181000,
        position: 1,
        mediumNumber: 1,
      },
      {
        title: 'Track 2',
        artists: ['Artist A'],
        duration: 200000,
        position: 2,
        mediumNumber: 1,
      },
    ];

    const rows = canonicalTrackRows('release-id', tracks);

    // Should have 2 rows (the duplicate is removed)
    expect(rows).toHaveLength(2);
    expect(rows[0]!.title).toBe('Track 1'); // First one kept
    expect(rows[1]!.title).toBe('Track 2');
  });

  it('should fill recordingMbid and trackMbid from CanonicalTrack', () => {
    const tracks: CanonicalTrack[] = [
      {
        title: 'Track 1',
        artists: ['Artist A'],
        duration: 180000,
        position: 1,
        mediumNumber: 1,
        recordingId: '11111111-1111-1111-1111-111111111111',
        trackId: '22222222-2222-2222-2222-222222222222',
      },
    ];

    const rows = canonicalTrackRows('release-id', tracks);

    expect(rows[0]!.recordingMbid).toBe('11111111-1111-1111-1111-111111111111');
    expect(rows[0]!.trackMbid).toBe('22222222-2222-2222-2222-222222222222');
  });

  it('should set mbids to null when not provided', () => {
    const tracks: CanonicalTrack[] = [
      {
        title: 'Track 1',
        artists: ['Artist A'],
        duration: 180000,
        position: 1,
        mediumNumber: 1,
      },
    ];

    const rows = canonicalTrackRows('release-id', tracks);

    expect(rows[0]!.recordingMbid).toBeNull();
    expect(rows[0]!.trackMbid).toBeNull();
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('upsertCanonical stable upsert (db)', () => {
  let ctx: WorkerContext;
  let dbInstance: any;
  let client: any;
  let releaseGroupIds: string[] = [];

  beforeAll(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL not set');
    const made = await makeDb(databaseUrl);
    dbInstance = made.db;
    client = made.client;
    ctx = { db: made.db, sql: made.client, boss: {} as any, logger: pino({ level: 'silent' }) };
  });

  afterAll(async () => {
    // Clean up: delete test releases and release groups
    for (const rgId of releaseGroupIds) {
      await dbInstance.delete(releaseGroups).where(eq(releaseGroups.id, rgId as any));
    }
    await client.end({ timeout: 5 });
  });

  it('should preserve track ids across re-fetch', async () => {
    const mbRelId = randomUUID();
    const mbRgId = randomUUID();
    const release1: CanonicalRelease = {
      id: mbRelId,
      releaseGroupId: mbRgId,
      title: 'Test Album',
      artists: ['Artist A'],
      tracks: [
        {
          title: 'Track 1',
          artists: ['Artist A'],
          duration: 180000,
          position: 1,
          mediumNumber: 1,
          recordingId: '12345678-1234-1234-1234-123456789012',
          trackId: '87654321-4321-4321-4321-210987654321',
        },
        {
          title: 'Track 2',
          artists: ['Artist A'],
          duration: 200000,
          position: 2,
          mediumNumber: 1,
          recordingId: '22345678-1234-1234-1234-123456789012',
          trackId: '97654321-4321-4321-4321-210987654321',
        },
      ],
      source: 'musicbrainz',
    };

    // First upsert
    const result1 = await upsertCanonical(ctx, release1);
    releaseGroupIds.push(result1.releaseGroupId);

    const tracks1 = await dbInstance
      .select()
      .from(canonicalTracks)
      .where(eq(canonicalTracks.releaseId, result1.releaseId as any));

    expect(tracks1).toHaveLength(2);
    const track1First = tracks1.find((t: any) => t.position === 1);
    const track2First = tracks1.find((t: any) => t.position === 2);
    const id1 = track1First!.id;
    const id2 = track2First!.id;

    expect(track1First!.recordingMbid).toBe('12345678-1234-1234-1234-123456789012');
    expect(track1First!.trackMbid).toBe('87654321-4321-4321-4321-210987654321');
    expect(track2First!.recordingMbid).toBe('22345678-1234-1234-1234-123456789012');
    expect(track2First!.trackMbid).toBe('97654321-4321-4321-4321-210987654321');

    // Second upsert with one title changed, track count reduced, ids added/unchanged
    const release2: CanonicalRelease = {
      ...release1,
      tracks: [
        {
          ...release1.tracks[0]!,
          title: 'Track 1 Updated',
          trackId: '87654321-4321-4321-4321-210987654321', // Same id
        },
        // Track 2 removed
      ],
    };

    await upsertCanonical(ctx, release2);

    const tracks2 = await dbInstance
      .select()
      .from(canonicalTracks)
      .where(eq(canonicalTracks.releaseId, result1.releaseId as any));

    // Should have 1 track (track 2 was deleted)
    expect(tracks2).toHaveLength(1);
    expect(tracks2[0]!.id).toBe(id1); // Same id
    expect(tracks2[0]!.title).toBe('Track 1 Updated'); // Title changed
    expect(tracks2[0]!.trackMbid).toBe('87654321-4321-4321-4321-210987654321'); // Id preserved

    // Track 2 should be gone
    const deletedTrack = await dbInstance
      .select()
      .from(canonicalTracks)
      .where(eq(canonicalTracks.id, id2 as any));
    expect(deletedTrack).toHaveLength(0);
  });

  it('should preserve ids when payload lacks them but older entry has them', async () => {
    const mbRelId = randomUUID();
    const mbRgId = randomUUID();
    const release1: CanonicalRelease = {
      id: mbRelId,
      releaseGroupId: mbRgId,
      title: 'Test Album 2',
      artists: ['Artist B'],
      tracks: [
        {
          title: 'Track A',
          artists: ['Artist B'],
          duration: 150000,
          position: 1,
          mediumNumber: 1,
          recordingId: '32345678-1234-1234-1234-123456789012',
          trackId: 'a7654321-4321-4321-4321-210987654321',
        },
      ],
      source: 'musicbrainz',
    };

    const result1 = await upsertCanonical(ctx, release1);
    releaseGroupIds.push(result1.releaseGroupId);

    const track1 = (
      await dbInstance
        .select()
        .from(canonicalTracks)
        .where(eq(canonicalTracks.releaseId, result1.releaseId as any))
    )[0]!;

    expect(track1.recordingMbid).toBe('32345678-1234-1234-1234-123456789012');
    expect(track1.trackMbid).toBe('a7654321-4321-4321-4321-210987654321');

    // Second upsert with payload lacking ids (simulates older cached payload)
    const release2: CanonicalRelease = {
      ...release1,
      tracks: [
        {
          title: 'Track A Updated',
          artists: ['Artist B'],
          duration: 150000,
          position: 1,
          mediumNumber: 1,
          // No recordingId or trackId
        },
      ],
    };

    await upsertCanonical(ctx, release2);

    const track2 = (
      await dbInstance
        .select()
        .from(canonicalTracks)
        .where(eq(canonicalTracks.releaseId, result1.releaseId as any))
    )[0]!;

    // Ids should be preserved (not nulled)
    expect(track2.recordingMbid).toBe('32345678-1234-1234-1234-123456789012');
    expect(track2.trackMbid).toBe('a7654321-4321-4321-4321-210987654321');
    expect(track2.title).toBe('Track A Updated');
  });
});

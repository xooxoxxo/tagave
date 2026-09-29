/**
 * A manual plan written to a real file and reverted, end to end against a
 * real database and the mutagen sidecar: preview → apply → revert (built
 * already previewed from the journal) → apply the revert. The file must
 * carry exactly its original tags again, including tags the manual plan
 * added where there were none (the compilation flag, a genre), which only an
 * explicit removal can undo.
 *
 * The file is a Hotel Costes piece as prod has it: ALBUMARTIST
 * "02. Stephane Pompougnac", its own ARTIST, no compilation flag, and an
 * album that is not identified.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { parseFile } from 'music-metadata';
import { audioFiles, libraries, localAlbums, localTracks, scanRoots, tagPlanItems, tagPlans, users, makeDb } from '@liner/db';
import type { WorkerContext } from '../lib/context.js';
import { MutagenTagWriter, resolvePythonInterpreter } from '../lib/tagWriter.js';
import { tagSnapshotOf } from '../lib/tagSnapshot.js';
import { tagsPreviewJob } from './tagsPreview.js';
import { tagsApplyJob } from './tagsApply.js';
import { tagsRevertJob } from './tagsRevert.js';

function toolsAvailable(): boolean {
  try {
    execSync(`"${resolvePythonInterpreter()}" -c "import mutagen"`, { stdio: 'pipe' });
    execSync('which ffmpeg', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!process.env.TEST_DATABASE_URL || !toolsAvailable())('manual plan: apply, then revert (db + sidecar)', () => {
  let ctx: WorkerContext;
  let db: any;
  let client: any;
  let tempDir: string;
  let writer: MutagenTagWriter;
  const userId = randomUUID();
  const libraryId = randomUUID();
  const rootId = randomUUID();
  const albumId = randomUUID();
  const fileId = randomUUID();
  const relPath = '#/02. Stephane Pompougnac/2008 - Hotel Costes Vol. 11/02 - Pacific Blue.mp3';

  const ORIGINAL = {
    title: 'Pacific Blue',
    artist: 'Morten Varano',
    album: 'Hotel Costes Vol. 11',
    albumartist: '02. Stephane Pompougnac',
    tracknumber: '2',
    date: '2008',
  };

  const snapshot = async () => {
    const full = path.join(tempDir, relPath);
    return tagSnapshotOf(await parseFile(full));
  };
  const itemsOf = async (planId: string) => db.select().from(tagPlanItems).where(eq(tagPlanItems.tagPlanId, planId));
  const planOf = async (planId: string) => (await db.select().from(tagPlans).where(eq(tagPlans.id, planId)))[0];

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;
    ctx = { db, sql: client, boss: { send: async () => randomUUID() } as any, logger: pino({ level: 'silent' }) };
    writer = new MutagenTagWriter();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'liner-manual-revert-'));
    const full = path.join(tempDir, relPath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    execSync(`ffmpeg -loglevel error -f lavfi -i "sine=frequency=440:duration=1" -c:a libmp3lame -b:a 128k -y "${full}"`, { stdio: 'pipe' });
    await writer.write(full, ORIGINAL, { id3Version: '2.4' });

    await db.insert(users).values({ id: userId, email: `manual-revert-${userId}@test.com`, passwordHash: 'x' });
    await db.insert(libraries).values({ id: libraryId, name: 'Manual revert', ownerUserId: userId, settings: { tagWritesEnabled: true } });
    await db.insert(scanRoots).values({ id: rootId, libraryId, path: tempDir, displayName: 'tmp', writable: true, probeWritable: true, enabled: true, validationStatus: 'ok', pollIntervalS: 3600 });
    const stat = await fs.stat(full);
    await db.insert(audioFiles).values({
      id: fileId, libraryId, scanRootId: rootId, relPath, sizeBytes: stat.size, container: 'MPEG', codec: 'MPEG 1 Layer 3',
      lossless: false, durationMs: 1000, status: 'present', tagsRaw: await snapshot(),
    });
    await db.insert(localAlbums).values({
      id: albumId, libraryId, clusterKey: `test:${albumId}`, dirPaths: [path.dirname(relPath)], titleGuess: ORIGINAL.album,
      artistGuess: ORIGINAL.albumartist, trackCount: 1, state: 'unidentified',
    });
    await db.insert(localTracks).values({ localAlbumId: albumId, audioFileId: fileId, trackNo: 2, state: 'unmatched' });
  }, 60_000);

  afterAll(async () => {
    await writer?.close();
    await db.delete(tagPlans).where(eq(tagPlans.libraryId, libraryId));
    await db.delete(localAlbums).where(eq(localAlbums.libraryId, libraryId));
    await db.delete(audioFiles).where(eq(audioFiles.libraryId, libraryId));
    await db.delete(scanRoots).where(eq(scanRoots.id, rootId));
    await db.delete(libraries).where(eq(libraries.id, libraryId));
    await db.delete(users).where(eq(users.id, userId));
    await client.end({ timeout: 5 });
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('writes the typed values to an unidentified album and restores the original tags on revert', async () => {
    const originalTags = await writer.read(path.join(tempDir, relPath));
    expect(originalTags['albumartist']).toBe('02. Stephane Pompougnac');
    expect(originalTags['compilation']).toBeUndefined();
    expect(originalTags['genre']).toBeUndefined();

    const planId = randomUUID();
    await db.insert(tagPlans).values({
      id: planId, libraryId, name: 'Set values: Hotel Costes Vol. 11', createdBy: userId, status: 'draft',
      scope: { type: 'albumIds', albumIds: [albumId] },
      policy: { preset: 'manual', id3Version: '2.4', multiValueSeparator: '; ', values: { albumartist: 'Various Artists', compilation: '1', genre: ['Lounge'] } },
    });

    await tagsPreviewJob(ctx, planId);
    const previewed = await planOf(planId);
    expect(previewed.status).toBe('previewed');
    expect(previewed.stats).toMatchObject({ filesTouched: 1, fieldsModified: 3, filesSkipped: [] });

    await tagsApplyJob(ctx, { planId });
    expect((await planOf(planId)).status).toBe('applied');
    const written = await writer.read(path.join(tempDir, relPath));
    expect(written).toMatchObject({ albumartist: 'Various Artists', compilation: true, genre: 'Lounge', artist: 'Morten Varano', album: ORIGINAL.album });

    const revertPlanId = randomUUID();
    await tagsRevertJob(ctx, { planId, revertPlanId });
    const revert = await planOf(revertPlanId);
    // born previewed, so it can be applied at once; a preview keeps its items
    expect(revert.status).toBe('previewed');
    expect(revert.policy).toMatchObject({ preset: 'revert', revertOf: planId });
    await tagsPreviewJob(ctx, revertPlanId);
    const revertItems = await itemsOf(revertPlanId);
    expect(revertItems).toHaveLength(1);
    const byField = Object.fromEntries((revertItems[0].diff as Array<{ field: string; after: unknown; reason: string }>).map((d) => [d.field, d]));
    expect(byField['albumartist']).toMatchObject({ after: '02. Stephane Pompougnac', reason: 'revert' });
    expect(byField['compilation']).toMatchObject({ after: null, reason: 'revert' });
    expect(byField['genre']).toMatchObject({ after: null, reason: 'revert' });

    await tagsApplyJob(ctx, { planId: revertPlanId });
    expect((await planOf(revertPlanId)).status).toBe('applied');
    expect((await planOf(planId)).status).toBe('reverted');

    const restored = await writer.read(path.join(tempDir, relPath));
    expect(restored).toEqual(originalTags);
    // and the catalogue reads the file as it was
    const [row] = await db.select().from(audioFiles).where(eq(audioFiles.id, fileId));
    expect(row.tagsRaw.common.albumartist).toBe('02. Stephane Pompougnac');
    expect(row.tagsRaw.common.compilation ?? false).toBe(false);
  }, 60_000);
});

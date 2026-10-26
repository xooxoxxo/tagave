/**
 * The noEmbeddedArt quality flag follows the files: an album whose files
 * carry a picture is not flagged, whether or not tagave has stored a front
 * cover for it yet (QA 2026-10-26 Q-19: Dummy, art in all 3 files, was
 * listed as "No embedded art").
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import pino from 'pino';
import { users, libraries, localAlbums, localTracks, audioFiles, scanRoots, gaps, makeDb } from '@tagave/db';
import type { WorkerContext } from '../lib/context.js';
import { gapsRecomputeJob } from './gapsRecompute.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('gaps.recompute noEmbeddedArt (db)', () => {
  let ctx: WorkerContext;
  let db: any;
  let client: { end: () => Promise<void> };
  const userId = randomUUID();
  const libraryId = randomUUID();
  const rootId = randomUUID();
  const withArt = randomUUID();
  const withoutArt = randomUUID();

  async function album(id: string, title: string, hasEmbeddedArt: boolean) {
    await db.insert(localAlbums).values({
      id, libraryId, clusterKey: `art-${id}`, dirPaths: [title], titleGuess: title, artistGuess: 'Portishead', state: 'unidentified', trackCount: 2,
    });
    for (const n of [1, 2]) {
      const fileId = randomUUID();
      await db.insert(audioFiles).values({
        id: fileId, libraryId, scanRootId: rootId, relPath: `${title}/${n}.mp3`, lossless: false, bitrateKbps: 320, hasEmbeddedArt,
        tagsRaw: { common: { title: `Track ${n}`, artist: 'Portishead', album: title, albumartist: 'Portishead', track: { no: n, of: 2 }, year: 1994 } },
      });
      await db.insert(localTracks).values({ localAlbumId: id, audioFileId: fileId, discNo: 1, trackNo: n });
    }
  }

  const flagsOf = async (id: string) =>
    ((await db.select().from(gaps).where(and(eq(gaps.subjectId, id), eq(gaps.kind, 'quality'), eq(gaps.state, 'open')))) as Array<{ flag: string }>)
      .map((g) => g.flag);

  beforeAll(async () => {
    const conn = await makeDb(process.env.TEST_DATABASE_URL!);
    db = conn.db;
    client = conn.client as unknown as { end: () => Promise<void> };
    ctx = { db: conn.db, sql: conn.client, boss: null as any, logger: pino({ level: 'silent' }) };
    await db.insert(users).values({ id: userId, email: `art-${userId}@test.com`, passwordHash: 'x' });
    await db.insert(libraries).values({ id: libraryId, name: 'Art flags', ownerUserId: userId });
    await db.insert(scanRoots).values({ id: rootId, libraryId, path: '/music', displayName: 'Music', validationStatus: 'ok' });
    await album(withArt, 'Dummy', true);
    await album(withoutArt, 'Bare', false);
    await gapsRecomputeJob(ctx, { libraryId });
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(libraries).where(eq(libraries.id, libraryId)); // cascades gaps, albums, files, roots
    await db.delete(users).where(eq(users.id, userId));
    await client.end();
  });

  it('does not flag an album whose files carry a picture', async () => {
    expect(await flagsOf(withArt)).not.toContain('noEmbeddedArt');
  });

  it('flags an album none of whose files carries a picture', async () => {
    expect(await flagsOf(withoutArt)).toContain('noEmbeddedArt');
  });
});

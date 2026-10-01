/**
 * art.fetch against a real database: once the album has a front image, its
 * "No cover art" flag must clear at once, not at the next nightly recompute
 * (the album page showed "No cover art · Fetch art" under the cover).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { audioFiles, images, libraries, localAlbums, localTracks, makeDb, scanRoots, sidecarFiles, users } from '@liner/db';
import type { WorkerContext } from '../lib/context.js';

const tmp = vi.hoisted(() => ({ dir: '' }));

describe.skipIf(!process.env.TEST_DATABASE_URL)('artFetchJob settles the noCover flag (db)', () => {
  let ctx: WorkerContext;
  let db: any;
  let client: any;
  let userId: string;
  let libraryId: string;
  let rootId: string;
  const send = vi.fn(async () => 'job-id');
  let artFetchJob: typeof import('./artFetch.js').artFetchJob;

  beforeAll(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL not set');
    tmp.dir = await mkdtemp(path.join(os.tmpdir(), 'liner-art-'));
    process.env.CACHE_DIR = path.join(tmp.dir, 'cache');
    ({ artFetchJob } = await import('./artFetch.js'));
    const made = await makeDb(databaseUrl);
    db = made.db;
    client = made.client;
    ctx = { db: made.db, sql: made.client, boss: { send } as any, logger: pino({ level: 'silent' }) };
    userId = randomUUID();
    await db.insert(users).values({ id: userId, email: `test-${userId}@test.com`, passwordHash: 'x' });
    libraryId = randomUUID();
    await db.insert(libraries).values({ id: libraryId, name: 'Art Library', ownerUserId: userId, settings: {} });
    rootId = randomUUID();
    await db.insert(scanRoots).values({ id: rootId, libraryId, path: path.join(tmp.dir, 'music'), displayName: 'music', validationStatus: 'ok' });
  });

  afterAll(async () => {
    await db.delete(libraries).where(eq(libraries.id, libraryId));
    await db.delete(users).where(eq(users.id, userId));
    await client.end();
    await rm(tmp.dir, { recursive: true, force: true });
  });

  /** An album folder with one track, and an open noCover flag on it. */
  async function albumWithFlag(dir: string, opts: { sidecar?: boolean } = {}) {
    const albumId = randomUUID();
    await db.insert(localAlbums).values({ id: albumId, libraryId, clusterKey: `art:${albumId}`, dirPaths: [dir], titleGuess: 'Thr!!!er' });
    const fileId = randomUUID();
    await db.insert(audioFiles).values({ id: fileId, libraryId, scanRootId: rootId, relPath: `${dir}/01.flac`, hasEmbeddedArt: false });
    await db.insert(localTracks).values({ localAlbumId: albumId, audioFileId: fileId, trackNo: 1 });
    if (opts.sidecar) {
      await mkdir(path.join(tmp.dir, 'music', dir), { recursive: true });
      await sharp({ create: { width: 64, height: 64, channels: 3, background: '#e8432e' } }).jpeg().toFile(path.join(tmp.dir, 'music', dir, 'cover.jpg'));
      await db.insert(sidecarFiles).values({ libraryId, scanRootId: rootId, relPath: `${dir}/cover.jpg`, kind: 'image', sizeBytes: 1000 });
    }
    await client`
      insert into gaps (library_id, kind, subject_type, subject_id, details, state, flag)
      values (${libraryId}, 'quality', 'local_album', ${albumId}, ${JSON.stringify({ flags: { noCover: true } })}::jsonb, 'open', 'noCover')`;
    return albumId;
  }
  const flagState = async (albumId: string) =>
    ((await client`select state, resolved_at from gaps where subject_id = ${albumId} and flag = 'noCover'`) as Array<{ state: string; resolved_at: Date | null }>)[0];

  it('art found in the folder: the image is stored, the flag resolves and the album is re-linted', async () => {
    send.mockClear();
    const albumId = await albumWithFlag('#/!!!/2013 - Thr!!!Er', { sidecar: true });
    await artFetchJob(ctx, { localAlbumId: albumId });
    const art = await db.select().from(images).where(eq(images.localAlbumId, albumId));
    expect(art).toHaveLength(1);
    expect(art[0].origin).toBe('sidecar');
    const flag = await flagState(albumId);
    expect(flag?.state).toBe('resolved');
    expect(flag?.resolved_at).toBeTruthy();
    expect(send).toHaveBeenCalledWith('gaps.recompute', { libraryId, albumIds: [albumId] }, {});
  });

  it('art already there (the flag went stale before it landed): the flag resolves', async () => {
    const albumId = await albumWithFlag('B/Band/2001 - Stale');
    await db.insert(images).values({
      libraryId, entityType: 'local_album', entityId: albumId, localAlbumId: albumId, kind: 'front', origin: 'owner', licenseNote: 'test',
    });
    await artFetchJob(ctx, { localAlbumId: albumId });
    expect((await flagState(albumId))?.state).toBe('resolved');
  });

  it('no art anywhere: the flag stays open', async () => {
    send.mockClear();
    const albumId = await albumWithFlag('N/Nothing/1999 - Bare');
    await artFetchJob(ctx, { localAlbumId: albumId });
    expect((await flagState(albumId))?.state).toBe('open');
    expect(send).not.toHaveBeenCalled();
  });
});

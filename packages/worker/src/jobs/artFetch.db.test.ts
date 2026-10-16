/**
 * art.fetch against a real database: once the album has a front image, its
 * "No cover art" flag must clear at once, not at the next nightly recompute
 * (the album page showed "No cover art · Fetch art" under the cover).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { audioFiles, images, libraries, localAlbums, localTracks, makeDb, scanRoots, sidecarFiles, users } from '@tagave/db';
import type { WorkerContext } from '../lib/context.js';

const tmp = vi.hoisted(() => ({ dir: '' }));
const sources: string[] = [];

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
    tmp.dir = await mkdtemp(path.join(os.tmpdir(), 'tagave-art-'));
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
    if (sources.length) await client`delete from image_sources where id = any(${sources}::uuid[])`;
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
    // the thumbnail lives in cover_thumbs (0046); images.thumb_bytes is no longer written
    expect(art[0].thumbBytes).toBeNull();
    const [thumb] = await client`select size, octet_length(bytes) as n, sha256 = sha256(bytes) as hashed from cover_thumbs where image_id = ${art[0].id}`;
    expect(thumb).toMatchObject({ size: 300, hashed: true });
    expect(Number(thumb.n)).toBeGreaterThan(100);
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

  /** An image source row for a provider cover (origin 'provider' needs one). */
  async function source(url: string): Promise<string> {
    const [r] = await client`insert into image_sources (entity_type, entity_id, kind, provider, source_url, license_note)
      values ('release', gen_random_uuid(), 'front', 'caa', ${url}, 'Cover Art Archive (test)') returning id`;
    sources.push(r.id as string);
    return r.id as string;
  }
  async function providerRow(albumId: string, url: string, localPath = path.join(tmp.dir, 'cache', 'covers', libraryId, 'lost.jpg')) {
    const imageSourceId = await source(url);
    const [row] = await db.insert(images).values({
      libraryId, entityType: 'local_album', entityId: albumId, localAlbumId: albumId, kind: 'front', origin: 'provider',
      imageSourceId, licenseNote: 'Cover Art Archive (test)', localPath,
    }).returning({ id: images.id });
    return { id: row.id as string, imageSourceId };
  }
  const standardOf = (albumId: string) => path.join(tmp.dir, 'cache', 'covers', libraryId, `${albumId}.jpg`);

  it('refresh of a provider cover: fetched again from its stored source into the same row (id kept), with its thumbnail', async () => {
    const albumId = await albumWithFlag('R/Refresh/2001 - Provider', { sidecar: true });
    const old = await providerRow(albumId, 'https://example.test/caa/front.jpg');
    const jpeg = await sharp({ create: { width: 500, height: 500, channels: 3, background: '#123456' } }).jpeg().toBuffer();
    const fetchMock = vi.fn(async () => new Response(new Uint8Array(jpeg), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await artFetchJob(ctx, { localAlbumId: albumId, refresh: true });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe('https://example.test/caa/front.jpg');
    const rows = await db.select().from(images).where(eq(images.localAlbumId, albumId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: old.id, origin: 'provider', imageSourceId: old.imageSourceId, localPath: standardOf(albumId) });
    expect(path.isAbsolute(rows[0].localPath)).toBe(true);
    await expect(access(standardOf(albumId))).resolves.toBeUndefined();
    expect(await client`select 1 from cover_thumbs where image_id = ${old.id}`).toHaveLength(1);
  });

  it('refresh: the stored source fails, so the usual order finds the folder\'s cover; the row id stays', async () => {
    const albumId = await albumWithFlag('R/Refresh/2002 - Again', { sidecar: true });
    const old = await providerRow(albumId, 'https://example.test/caa/gone.jpg');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gone', { status: 404 })));
    try {
      await artFetchJob(ctx, { localAlbumId: albumId, refresh: true });
    } finally {
      vi.unstubAllGlobals();
    }
    const rows = await db.select().from(images).where(eq(images.localAlbumId, albumId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: old.id, origin: 'sidecar', localPath: standardOf(albumId) });
    expect(await client`select 1 from cover_thumbs where image_id = ${old.id}`).toHaveLength(1);
  });

  it('refresh leaves the owner\'s own cover alone', async () => {
    const albumId = await albumWithFlag('R/Refresh/2004 - Mine', { sidecar: true });
    const [old] = await db.insert(images).values({
      libraryId, entityType: 'local_album', entityId: albumId, localAlbumId: albumId, kind: 'front', origin: 'owner', licenseNote: 'mine', localPath: '/mine.jpg',
    }).returning({ id: images.id });
    await artFetchJob(ctx, { localAlbumId: albumId, refresh: true });
    const rows = await db.select().from(images).where(eq(images.localAlbumId, albumId));
    expect(rows.map((r: any) => [r.id, r.origin, r.localPath])).toEqual([[old.id, 'owner', '/mine.jpg']]);
    expect(await client`select 1 from cover_thumbs where image_id = ${old.id}`).toHaveLength(0);
  });

  it('refresh with no art to be found leaves the row as it was', async () => {
    const albumId = await albumWithFlag('R/Refresh/2003 - Nothing');
    const old = await providerRow(albumId, 'https://example.test/caa/none.jpg', '/x.jpg');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gone', { status: 404 })));
    try {
      await artFetchJob(ctx, { localAlbumId: albumId, refresh: true });
    } finally {
      vi.unstubAllGlobals();
    }
    const rows = await db.select().from(images).where(eq(images.localAlbumId, albumId));
    expect(rows.map((r: any) => [r.id, r.localPath])).toEqual([[old.id, '/x.jpg']]);
  });

  it('no art anywhere: the flag stays open', async () => {
    send.mockClear();
    const albumId = await albumWithFlag('N/Nothing/1999 - Bare');
    await artFetchJob(ctx, { localAlbumId: albumId });
    expect((await flagState(albumId))?.state).toBe('open');
    expect(send).not.toHaveBeenCalled();
  });
});

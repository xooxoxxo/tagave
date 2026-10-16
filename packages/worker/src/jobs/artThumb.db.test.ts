/**
 * art.thumb / art.thumbSweep against a real database: backups leave
 * cover_thumbs out (0046), so after a restore every cover needs its
 * thumbnail rebuilt from the original on the cache volume. Nothing here
 * deletes an images row: a gone original is sent to art.fetch as a refresh,
 * only when the cache looks like the one the covers were made on, and at
 * most 200 a day for the install.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { eq, inArray } from 'drizzle-orm';
import pino from 'pino';
import { PgBoss } from 'pg-boss';
import { images, libraries, localAlbums, makeDb, users } from '@tagave/db';
import type { WorkerContext } from '../lib/context.js';
import {
  REFETCH_PRIORITY, REFETCH_SPACING_SECONDS, SWEEP_INSERT_CHUNK, allowedMissing, artThumbJob, artThumbKey,
  artThumbSweepJob, cacheRoot, locateOriginal,
} from './artThumb.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('art.thumb rebuilds missing cover thumbnails (db)', () => {
  let ctx: WorkerContext;
  let db: any;
  let client: any;
  let dir: string;
  let jpeg: Buffer;
  const userId = randomUUID();
  const libs: string[] = [];
  /** The provider source every test cover came from (origin 'provider' needs one). */
  let sourceId: string;
  const send = vi.fn(async (..._args: unknown[]) => 'job-id');
  const insert = vi.fn(async (..._args: unknown[]) => [] as string[]);
  const warn = vi.fn();

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'tagave-thumb-'));
    jpeg = await sharp({ create: { width: 600, height: 500, channels: 3, background: '#2e8be8' } }).jpeg().toBuffer();
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    db = made.db;
    client = made.client;
    const logger = pino({ level: 'silent' });
    logger.warn = warn as any;
    ctx = { db: made.db, sql: made.client, boss: { send, insert } as any, logger };
    await db.insert(users).values({ id: userId, email: `thumb-${userId}@test.com`, passwordHash: 'x' });
    await client`delete from cover_rebuild_log where kind = 'refetch'`;
    const [src] = await client`insert into image_sources (entity_type, entity_id, kind, provider, source_url, license_note)
      values ('release', gen_random_uuid(), 'front', 'caa', 'https://example.test/front.jpg', 'test') returning id`;
    sourceId = src.id;
  });

  afterAll(async () => {
    await client`delete from cover_rebuild_log where kind = 'refetch'`;
    if (libs.length) await db.delete(libraries).where(inArray(libraries.id, libs));
    await db.delete(users).where(eq(users.id, userId));
    await client`delete from image_sources where id = ${sourceId}`;
    await client.end();
    await rm(dir, { recursive: true, force: true });
  }, 120_000); // the 27,000-cover library takes a while to cascade away

  /** A library and a cache root of its own, so each sweep sees only its covers. */
  async function setup() {
    const libraryId = randomUUID();
    libs.push(libraryId);
    await db.insert(libraries).values({ id: libraryId, name: 'Thumbs', ownerUserId: userId, settings: {} });
    const root = path.join(dir, `cache-${libraryId.slice(0, 8)}`);
    await mkdir(path.join(root, 'covers', libraryId), { recursive: true });
    return { libraryId, root };
  }

  /** An album with a front image row whose original is (or is not) on disk. */
  async function cover(libraryId: string, root: string, opts: { original?: 'jpeg' | 'missing'; localPath?: string; thumb?: boolean; origin?: 'owner' } = {}) {
    const albumId = randomUUID();
    await db.insert(localAlbums).values({ id: albumId, libraryId, clusterKey: `t:${albumId}`, dirPaths: [albumId], titleGuess: 'T' });
    const standard = path.join(root, 'covers', libraryId, `${albumId}.jpg`);
    const localPath = opts.localPath ?? standard;
    if ((opts.original ?? 'jpeg') === 'jpeg') await writeFile(localPath, jpeg);
    const [img] = await db.insert(images).values({
      libraryId, entityType: 'local_album', entityId: albumId, localAlbumId: albumId, kind: 'front',
      ...(opts.origin === 'owner' ? { origin: 'owner' } : { origin: 'provider', imageSourceId: sourceId }),
      licenseNote: 'test', localPath, width: 600, height: 500,
    }).returning({ id: images.id });
    if (opts.thumb) await client`insert into cover_thumbs (image_id, bytes, sha256) values (${img.id}, ${Buffer.from([1])}, ${Buffer.alloc(32)})`;
    return { albumId, imageId: img.id as string, standard };
  }
  /** Many covers at once, straight in SQL: no thumbnail, originals at the standard path but not on disk. */
  async function bulkCovers(libraryId: string, root: string, n: number) {
    await client`
      with a as (
        insert into local_albums (library_id, cluster_key, dir_paths, title_guess)
        select ${libraryId}, 'bulk:' || g || ':' || ${libraryId}, array['B/' || g], 'B' from generate_series(1, ${n}) g
        returning id)
      insert into images (library_id, entity_type, entity_id, local_album_id, kind, origin, image_source_id, license_note, local_path)
      select ${libraryId}, 'local_album', id, id, 'front', 'provider', ${sourceId}, 'test', ${path.join(root, 'covers', libraryId)} || '/' || id || '.jpg' from a`;
  }
  const thumbOf = async (imageId: string) =>
    (await client`select bytes, sha256 from cover_thumbs where image_id = ${imageId}`)[0] as { bytes: Buffer; sha256: Buffer } | undefined;
  const imageCount = async (libraryId: string) => (await client`select count(*)::int as n from images where library_id = ${libraryId}`)[0].n as number;
  const imageRow = async (imageId: string) => (await db.select().from(images).where(eq(images.id, imageId)))[0];
  const fetchSends = () => send.mock.calls.filter((c) => c[0] === 'art.fetch');
  const loudWarnings = () => warn.mock.calls.filter((c) => String(c[1]).includes('check that the cache volume is mounted'));
  const refetchLogRows = async () => (await client`select count(*)::int as n from cover_rebuild_log where kind = 'refetch'`)[0].n as number;
  /** A healthy library: `n` covers with a thumbnail and their originals on disk. */
  async function healthy(libraryId: string, root: string, n: number) {
    for (let i = 0; i < n; i++) await cover(libraryId, root, { thumb: true });
  }

  it('cacheRoot follows CACHE_DIR, as an absolute path', () => {
    expect(cacheRoot({ CACHE_DIR: '/srv/cache' })).toBe('/srv/cache');
    expect(path.isAbsolute(cacheRoot({ CACHE_DIR: 'rel/cache' }))).toBe(true);
  });

  it('no DELETE anywhere in artThumb.ts: nothing here removes an images row', async () => {
    const src = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'artThumb.ts'), 'utf8');
    expect(src).not.toMatch(/\.delete\(/);
    expect(src).not.toMatch(/delete\s+from/i);
  });

  it('allowedMissing: 2 % of the library\'s front covers, at least 1, at most 50', () => {
    expect([allowedMissing(0), allowedMissing(40), allowedMissing(100), allowedMissing(1000), allowedMissing(27_129)]).toEqual([1, 1, 2, 20, 50]);
  });

  it('rebuilds a 300px JPEG from the original, hashed for the ETag; a second run finds it there', async () => {
    const { libraryId, root } = await setup();
    const { imageId } = await cover(libraryId, root);
    expect(await artThumbJob(ctx, { imageId }, root)).toBe('rebuilt');
    const row = await thumbOf(imageId);
    const meta = await sharp(row!.bytes).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 300, 300]);
    expect(Buffer.from(row!.sha256).equals(createHash('sha256').update(row!.bytes).digest())).toBe(true);
    expect(await artThumbJob(ctx, { imageId }, root)).toBe('present');
  });

  it('the stored path is gone but the standard one exists: uses it and fixes local_path', async () => {
    const { libraryId, root } = await setup();
    const { imageId, standard } = await cover(libraryId, root, { original: 'missing', localPath: path.join(root, 'old-layout', 'cover.jpg') });
    await writeFile(standard, jpeg);
    expect(await artThumbJob(ctx, { imageId }, root)).toBe('rebuilt');
    expect((await imageRow(imageId)).localPath).toBe(standard);
  });

  it('art.thumb itself leaves a gone original alone (the sweep decides)', async () => {
    send.mockClear();
    const { libraryId, root } = await setup();
    const { imageId } = await cover(libraryId, root, { original: 'missing' });
    expect(await artThumbJob(ctx, { imageId }, root)).toBe('missing');
    expect(await imageRow(imageId)).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });

  it('a path outside this worker\'s cache (another computer) is left alone, by the job and the sweep', async () => {
    send.mockClear();
    const { libraryId, root } = await setup();
    await cover(libraryId, root);
    const elsewhere = '/elsewhere/cache/covers/x.jpg';
    const { imageId } = await cover(libraryId, root, { original: 'missing', localPath: elsewhere });
    expect(await locateOriginal({ id: imageId, libraryId, localAlbumId: null, localPath: elsewhere }, root)).toEqual({ state: 'elsewhere' });
    expect(await artThumbJob(ctx, { imageId }, root)).toBe('elsewhere');
    const r = await artThumbSweepJob(ctx, { libraryId }, root);
    expect(r.libraries[0]).toMatchObject({ found: 1, skipped: 1, gone: 0, refetched: 0 });
    expect(fetchSends()).toHaveLength(0);
  });

  it('a read error other than ENOENT (EACCES) is left alone', async () => {
    send.mockClear();
    const { libraryId, root } = await setup();
    const locked = path.join(root, 'covers', libraryId, 'locked');
    await mkdir(locked);
    const lockedPath = path.join(locked, 'a.jpg');
    const { imageId } = await cover(libraryId, root, { localPath: lockedPath });
    await chmod(locked, 0o000);
    try {
      expect(await locateOriginal({ id: imageId, libraryId, localAlbumId: null, localPath: lockedPath }, root))
        .toEqual({ state: 'error', code: 'EACCES' });
      const r = await artThumbSweepJob(ctx, { libraryId }, root);
      expect(r.refetched).toBe(0);
      expect(await imageRow(imageId)).toBeTruthy();
    } finally {
      await chmod(locked, 0o755);
    }
  });

  it('the sweep queues art.thumb for covers it can rebuild, in chunks, by singleton key', async () => {
    insert.mockClear();
    const { libraryId, root } = await setup();
    const a = await cover(libraryId, root);
    const b = await cover(libraryId, root);
    await writeFile(path.join(root, 'covers', libraryId, '.DS_Store'), 'x'); // dotfiles never count
    const done = await cover(libraryId, root);
    await artThumbJob(ctx, { imageId: done.imageId }, root);
    const r = await artThumbSweepJob(ctx, { libraryId }, root);
    expect(r).toMatchObject({ covers: 2, queued: 2 });
    expect(insert).toHaveBeenCalledTimes(1);
    const [queue, jobs] = insert.mock.calls[0] as [string, Array<{ data: { imageId: string }; singletonKey: string }>];
    expect(queue).toBe('art.thumb');
    expect(jobs.map((j) => j.data.imageId).sort()).toEqual([a.imageId, b.imageId].sort());
    for (const j of jobs) expect(j.singletonKey).toBe(artThumbKey(j.data.imageId));
    expect(SWEEP_INSERT_CHUNK).toBe(1000);
  });

  it('an empty cache (unmounted or fresh volume): 0 refetches and one loud warning', async () => {
    send.mockClear();
    warn.mockClear();
    const { libraryId, root } = await setup();
    for (let i = 0; i < 30; i++) await cover(libraryId, root, { original: 'missing' });
    const r = await artThumbSweepJob(ctx, { libraryId }, root);
    expect(r.libraries[0]).toMatchObject({ found: 0, gone: 30, refetched: 0, suspicious: true });
    expect(fetchSends()).toHaveLength(0);
    expect(loudWarnings()).toHaveLength(1);
    expect(await imageCount(libraryId)).toBe(30);
  });

  it('a shadow folder with one new file over 27,000 restored covers: 0 refetches and one loud warning', async () => {
    send.mockClear();
    warn.mockClear();
    const { libraryId, root } = await setup();
    await bulkCovers(libraryId, root, 27_000);
    await cover(libraryId, root); // the one file in the new, empty-looking volume
    const r = await artThumbSweepJob(ctx, { libraryId }, root);
    expect(r.libraries[0]).toMatchObject({ frontCovers: 27_001, found: 1, gone: 27_000, refetched: 0, suspicious: true });
    expect(fetchSends()).toHaveLength(0);
    expect(loudWarnings()).toHaveLength(1);
    expect(await imageCount(libraryId)).toBe(27_001);
  }, 120_000);

  it('a 40-album library with one gone original: one refresh, at low priority; the row stays', async () => {
    send.mockClear();
    warn.mockClear();
    const { libraryId, root } = await setup();
    for (let i = 0; i < 39; i++) await cover(libraryId, root);
    const lost = await cover(libraryId, root, { original: 'missing' });
    const r = await artThumbSweepJob(ctx, { libraryId }, root);
    expect(r.libraries[0]).toMatchObject({ frontCovers: 40, found: 39, gone: 1, refetched: 1, suspicious: false });
    expect(fetchSends()).toEqual([[
      'art.fetch', { localAlbumId: lost.albumId, refresh: true },
      { singletonKey: `artRefresh:${lost.albumId}`, startAfter: 0, priority: REFETCH_PRIORITY },
    ]]);
    expect(await imageRow(lost.imageId)).toBeTruthy();
    expect(loudWarnings()).toHaveLength(0);
  });

  it('more gone than 2 % of the library: nothing is refetched', async () => {
    send.mockClear();
    const { libraryId, root } = await setup();
    for (let i = 0; i < 95; i++) await cover(libraryId, root);
    for (let i = 0; i < 5; i++) await cover(libraryId, root, { original: 'missing' }); // 100 covers allow 2
    const r = await artThumbSweepJob(ctx, { libraryId }, root);
    expect(r.libraries[0]).toMatchObject({ found: 95, gone: 5, refetched: 0, suspicious: true });
    expect(fetchSends()).toHaveLength(0);
  });

  it('the 24 h budget (200 refetches per install) holds across sweeps, spread 5 s apart', async () => {
    await client`delete from cover_rebuild_log where kind = 'refetch'`;
    // 198 refetches already spent today by other sweeps
    await client`insert into cover_rebuild_log (kind, album_id) select 'refetch', gen_random_uuid() from generate_series(1, 198)`;
    const a = await setup();
    const b = await setup();
    for (const l of [a, b]) {
      for (let i = 0; i < 100; i++) await cover(l.libraryId, l.root);
      for (let i = 0; i < 2; i++) await cover(l.libraryId, l.root, { original: 'missing' });
    }
    send.mockClear();
    // sweep 1: two left in the budget, both go
    const s1 = await artThumbSweepJob(ctx, { libraryId: a.libraryId }, a.root);
    expect(s1.libraries[0]).toMatchObject({ gone: 2, refetched: 2, overBudget: 0 });
    expect(fetchSends().map((c) => (c[2] as { startAfter: number }).startAfter)).toEqual([0, REFETCH_SPACING_SECONDS]);
    // sweep 2: spent
    const s2 = await artThumbSweepJob(ctx, { libraryId: b.libraryId }, b.root);
    expect(s2.libraries[0]).toMatchObject({ gone: 2, refetched: 0, overBudget: 2 });
    // sweep 3, a day later: room again
    await client`update cover_rebuild_log set at = now() - interval '25 hours' where kind = 'refetch'`;
    const s3 = await artThumbSweepJob(ctx, { libraryId: b.libraryId }, b.root);
    expect(s3.libraries[0]).toMatchObject({ refetched: 2, overBudget: 0 });
    expect(fetchSends()).toHaveLength(4);
    // and an album sent in the last day is not sent again by the next sweep
    const s4 = await artThumbSweepJob(ctx, { libraryId: b.libraryId }, b.root);
    expect(s4.libraries[0]).toMatchObject({ gone: 2, refetched: 0 });
    expect(fetchSends()).toHaveLength(4);
    await client`delete from cover_rebuild_log where kind = 'refetch'`;
  }, 60_000);

  it('a leftover gone cover in a healthy library is refetched (the sample says the volume is fine)', async () => {
    send.mockClear();
    warn.mockClear();
    const { libraryId, root } = await setup();
    await healthy(libraryId, root, 40);
    const lost = await cover(libraryId, root, { original: 'missing' });
    const r = await artThumbSweepJob(ctx, { libraryId }, root);
    expect(r.libraries[0]).toMatchObject({ found: 0, gone: 1, sampled: 40, sampledMissing: 0, refetched: 1, suspicious: false });
    expect(fetchSends().map((c) => (c[1] as { localAlbumId: string }).localAlbumId)).toEqual([lost.albumId]);
    expect(loudWarnings()).toHaveLength(0);
    await client`delete from cover_rebuild_log where kind = 'refetch'`;
  });

  it('sweep 2 refetches what sweep 1 left over the daily budget', async () => {
    send.mockClear();
    warn.mockClear();
    await client`delete from cover_rebuild_log where kind = 'refetch'`;
    await client`insert into cover_rebuild_log (kind, album_id) select 'refetch', gen_random_uuid() from generate_series(1, 200)`;
    const { libraryId, root } = await setup();
    await healthy(libraryId, root, 100); // 102 covers: 2 may be refetched per sweep
    const lost = [await cover(libraryId, root, { original: 'missing' }), await cover(libraryId, root, { original: 'missing' })];
    const s1 = await artThumbSweepJob(ctx, { libraryId }, root);
    expect(s1.libraries[0]).toMatchObject({ gone: 2, refetched: 0, overBudget: 2, suspicious: false });
    expect(loudWarnings()).toHaveLength(0); // the budget is not the volume's fault
    await client`update cover_rebuild_log set at = now() - interval '25 hours' where kind = 'refetch'`;
    const s2 = await artThumbSweepJob(ctx, { libraryId }, root);
    expect(s2.libraries[0]).toMatchObject({ gone: 2, refetched: 2, overBudget: 0 });
    expect(fetchSends().map((c) => (c[1] as { localAlbumId: string }).localAlbumId).sort()).toEqual(lost.map((l) => l.albumId).sort());
    await client`delete from cover_rebuild_log where kind = 'refetch'`;
  });

  it('a broken volume (the sampled originals are missing): 0 refetches and a warning naming the sample', async () => {
    send.mockClear();
    warn.mockClear();
    const { libraryId, root } = await setup();
    for (let i = 0; i < 40; i++) await cover(libraryId, root, { thumb: true, original: 'missing' });
    await cover(libraryId, root, { original: 'missing' });
    const r = await artThumbSweepJob(ctx, { libraryId }, root);
    expect(r.libraries[0]).toMatchObject({ gone: 1, sampled: 40, sampledMissing: 40, refetched: 0, suspicious: true });
    expect(fetchSends()).toHaveLength(0);
    expect(loudWarnings()).toHaveLength(1);
    expect(String(loudWarnings()[0]![1])).toContain(`40 of 40 sampled originals missing in library ${libraryId}`);
  });

  it('a tiny library with every original lost is blocked, and the warning says what was measured', async () => {
    send.mockClear();
    warn.mockClear();
    const { libraryId, root } = await setup();
    for (let i = 0; i < 3; i++) await cover(libraryId, root, { thumb: true, original: 'missing' });
    await cover(libraryId, root, { original: 'missing' });
    const r = await artThumbSweepJob(ctx, { libraryId }, root);
    expect(r.libraries[0]).toMatchObject({ frontCovers: 4, gone: 1, sampled: 3, sampledMissing: 3, refetched: 0, suspicious: true });
    expect(String(loudWarnings()[0]![1])).toMatch(
      new RegExp(`^art.thumb sweep: 3 of 3 sampled originals missing in library ${libraryId}; check that the cache volume is mounted`));
    expect(fetchSends()).toHaveLength(0);
  });

  it('the owner\'s own cover is never refetched', async () => {
    send.mockClear();
    const { libraryId, root } = await setup();
    await healthy(libraryId, root, 10);
    await cover(libraryId, root, { original: 'missing', origin: 'owner' });
    const r = await artThumbSweepJob(ctx, { libraryId }, root);
    expect(r.libraries[0]).toMatchObject({ gone: 0, skipped: 1, refetched: 0 });
    expect(fetchSends()).toHaveLength(0);
  });

  it('a refetch pg-boss does not queue (already queued, or an error) gives its reservation back', async () => {
    await client`delete from cover_rebuild_log where kind = 'refetch'`;
    const { libraryId, root } = await setup();
    await healthy(libraryId, root, 100);
    await cover(libraryId, root, { original: 'missing' });
    await cover(libraryId, root, { original: 'missing' });
    send.mockReset();
    send.mockResolvedValueOnce(null as unknown as string).mockRejectedValueOnce(new Error('queue down'));
    const r = await artThumbSweepJob(ctx, { libraryId }, root);
    expect(r.libraries[0]).toMatchObject({ gone: 2, refetched: 0, overBudget: 2 });
    expect(await refetchLogRows()).toBe(0);
    send.mockReset();
    send.mockImplementation(async () => 'job-id');
  });

  it('pg-boss keeps one queued art.thumb per image when the sweep inserts it twice', async () => {
    // in a scratch database: other suites fake pgboss.job in the shared one
    const name = `tagave_thumbq_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    await client.unsafe(`create database ${name}`);
    const u = new URL(process.env.TEST_DATABASE_URL!);
    u.pathname = `/${name}`;
    const boss = new PgBoss(u.toString());
    boss.on('error', () => undefined);
    try {
      await boss.start();
      await boss.createQueue('art.thumb', { policy: 'stately' });
      const key = artThumbKey(randomUUID());
      await boss.insert('art.thumb', [{ data: { imageId: 'x' }, singletonKey: key }]);
      await boss.insert('art.thumb', [{ data: { imageId: 'x' }, singletonKey: key }]);
      const jobs = await boss.findJobs('art.thumb', { key });
      expect(jobs).toHaveLength(1);
    } finally {
      await boss.stop({ graceful: false }).catch(() => undefined);
      await client.unsafe(`drop database if exists ${name} with (force)`);
    }
  }, 30_000);
});

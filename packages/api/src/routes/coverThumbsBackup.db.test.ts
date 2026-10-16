/**
 * Backups leave cover thumbnails and the provider cache out (0046): a backup
 * of a library with thumbnails is much smaller than a full pg_dump, restores
 * with --exit-on-error into a database that has both tables, empty, and the
 * app then serves a placeholder for every cover and asks for its rebuild.
 *
 * Needs pg_dump and pg_restore 16 (PATH, or PG_DUMP / PG_RESTORE); skipped
 * with the reason printed when missing.
 */
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import Fastify, { type FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pgDumpBin, pgRestoreBin, runBackup, runRestore } from '@tagave/doctor';
import { createScratchDb, migrateAll } from '../testkit/authApp.js';

const run = promisify(execFile);
const url = process.env.TEST_DATABASE_URL;

function toolsMissing(): string | null {
  for (const bin of [pgDumpBin(), pgRestoreBin()]) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'pipe' });
    } catch {
      return `${bin} is not available (install postgresql-client-16 or set PG_DUMP / PG_RESTORE)`;
    }
  }
  return null;
}
const missing = url ? toolsMissing() : 'TEST_DATABASE_URL is not set';
if (missing) console.warn(`[coverThumbsBackup.db.test] skipped: ${missing}`);

const ALBUMS = 120;
const THUMB_BYTES = 22_000; // a typical 300px q82 JPEG; random bytes compress no better than JPEG

describe.skipIf(!!missing)('cover thumbnails and the provider cache stay out of backups (integration)', () => {
  let admin: postgres.Sql;
  let source: { url: string; name: string };
  let target: { url: string; name: string };
  const extraDbs: string[] = [];
  let dir: string;
  let fullBytes = 0;
  let backup: { path: string; bytes: number };
  const albumIds: string[] = [];
  const imageIds: string[] = [];
  let ownerId: string;

  beforeAll(async () => {
    admin = postgres(url!, { max: 1, onnotice: () => undefined });
    source = await createScratchDb(url!, admin);
    target = await createScratchDb(url!, admin);
    await migrateAll(source.url);
    dir = await mkdtemp(join(tmpdir(), 'tagave-thumbs-backup-'));

    const sql = postgres(source.url, { max: 1, onnotice: () => undefined });
    try {
      ownerId = randomUUID();
      const libraryId = randomUUID();
      await sql`insert into users (id, email, display_name, password_hash) values (${ownerId}, ${`o-${ownerId}@test.com`}, 'Owner', 'x')`;
      await sql`insert into libraries (id, owner_user_id, name, settings) values (${libraryId}, ${ownerId}, 'Thumbs', '{}')`;
      for (let i = 0; i < ALBUMS; i++) {
        const albumId = randomUUID();
        albumIds.push(albumId);
        await sql`insert into local_albums (id, library_id, cluster_key, dir_paths, title_guess)
                  values (${albumId}, ${libraryId}, ${`k:${albumId}`}, ${[`A/${i}`]}, ${`Album ${i}`})`;
        const [img] = await sql`insert into images (library_id, entity_type, entity_id, local_album_id, kind, origin, license_note, local_path)
                  values (${libraryId}, 'local_album', ${albumId}, ${albumId}, 'front', 'owner', 'test', ${`/cache/covers/${libraryId}/${albumId}.jpg`})
                  returning id`;
        imageIds.push(img!['id'] as string);
        const thumb = randomBytes(THUMB_BYTES);
        await sql`insert into cover_thumbs (image_id, bytes, sha256) values (${img!['id'] as string}, ${thumb}, sha256(${thumb}::bytea))`;
      }
      for (let i = 0; i < 50; i++) {
        await sql`insert into provider_cache (provider, cache_key, payload)
                  values ('musicbrainz', ${`release:${i}`}, ${sql.json({ blob: randomBytes(4000).toString('base64') })})`;
      }
    } finally {
      await sql.end({ timeout: 2 });
    }

    // what a backup weighed before 0046: everything in it
    const full = join(dir, 'full.pgdump');
    await run(pgDumpBin(), ['--format=custom', `--file=${full}`, `--dbname=${source.url}`]);
    fullBytes = (await stat(full)).size;
    backup = await runBackup({ databaseUrl: source.url, outDir: dir, kind: 'manual' });
  }, 120_000);

  afterAll(async () => {
    for (const db of [source?.name, target?.name, ...extraDbs]) {
      if (db) await admin.unsafe(`drop database if exists ${db} with (force)`).catch(() => undefined);
    }
    await admin?.end({ timeout: 2 });
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('the backup holds neither table\'s rows, so it is much smaller', async () => {
    const { stdout } = await run(pgRestoreBin(), ['--list', backup.path]);
    expect(stdout).toMatch(/TABLE public cover_thumbs /);
    expect(stdout).toMatch(/TABLE public provider_cache /);
    expect(stdout).not.toMatch(/TABLE DATA public cover_thumbs /);
    expect(stdout).not.toMatch(/TABLE DATA public provider_cache /);
    expect(stdout).toMatch(/TABLE DATA public images /);
    // the thumbnails were most of the full dump
    expect(fullBytes - backup.bytes).toBeGreaterThan(ALBUMS * THUMB_BYTES * 0.9);
    console.info(`[coverThumbsBackup] full dump ${fullBytes} bytes, tagave backup ${backup.bytes} bytes`);
  });

  it('a pre-migration dump (a roll back) keeps the provider cache, still without thumbnails', async () => {
    const pre = await runBackup({ databaseUrl: source.url, outDir: dir, kind: 'pre-migration' });
    const { stdout } = await run(pgRestoreBin(), ['--list', pre.path]);
    expect(stdout).toMatch(/TABLE DATA public provider_cache /);
    expect(stdout).not.toMatch(/TABLE DATA public cover_thumbs /);
  });

  describe('after a restore', () => {
    let app: FastifyInstance;
    let client: postgres.Sql;
    const requestRebuild = vi.fn(async (_imageId: string) => undefined);

    beforeAll(async () => {
      const result = await runRestore({ databaseUrl: target.url, file: backup.path, mode: 'swap', backupDir: dir, force: true });
      if (result.previousDatabase) extraDbs.push(result.previousDatabase);
      const { initDb } = await import('../db.js');
      client = (await initDb(target.url)).client;
      const { errorHandler } = await import('../middleware/errorHandler.js');
      const { createImageRoutes } = await import('./images.js');
      app = Fastify({ logger: false });
      await errorHandler(app);
      app.addHook('preHandler', async (request) => {
        request.user = { id: ownerId, email: 'o@test.com', role: 'owner' } as any;
      });
      await app.register(createImageRoutes, { prefix: '/api/v1', requestRebuild });
      await app.ready();
    }, 120_000);

    afterAll(async () => {
      await app?.close();
      await client?.end({ timeout: 2 });
    });

    it('both tables exist and are empty; the album covers themselves came back', async () => {
      expect((await client`select count(*)::int as n from cover_thumbs`)[0]!['n']).toBe(0);
      expect((await client`select count(*)::int as n from provider_cache`)[0]!['n']).toBe(0);
      expect((await client`select count(*)::int as n from images where kind = 'front'`)[0]!['n']).toBe(ALBUMS);
    });

    it('serves the placeholder for a cover and asks for its thumbnail to be rebuilt', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/v1/images/album/${albumIds[0]}` });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/^image\/svg\+xml/);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(requestRebuild).toHaveBeenCalledWith(imageIds[0]);
    });
  });
});

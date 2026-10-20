/**
 * Move-safe scanning migrations: 0052 adds the reconcile columns, turns
 * millisecond mtimes into seconds, and lets a file's or sidecar's cover row
 * go with it; 0053 (Task 2) dedupes local_tracks under a NULLS NOT DISTINCT key.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScratchDb, migrateAll, migrateUpTo } from '../testkit/authApp.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('0052 move-safe files migration (integration)', () => {
  let admin: postgres.Sql;
  let db: { url: string; name: string };
  let sql: postgres.Sql;
  const libraryId = randomUUID();
  const rootId = randomUUID();
  const msFile = randomUUID();
  const sFile = randomUUID();

  beforeAll(async () => {
    admin = postgres(url!, { max: 1, onnotice: () => undefined });
    db = await createScratchDb(url!, admin);
    await migrateUpTo(db.url, '0052');
    sql = postgres(db.url, { max: 2, onnotice: () => undefined });
    const userId = randomUUID();
    await sql`insert into users (id, email, display_name, password_hash) values (${userId}, ${`m-${userId}@test.com`}, 'M', 'x')`;
    await sql`insert into libraries (id, owner_user_id, name, settings) values (${libraryId}, ${userId}, 'M', '{}')`;
    await sql`insert into scan_roots (id, library_id, path, display_name) values (${rootId}, ${libraryId}, '/music', 'm')`;
    await sql`insert into audio_files (id, library_id, scan_root_id, rel_path, size_bytes, mtime)
              values (${msFile}, ${libraryId}, ${rootId}, 'A/1.flac', 10, 1760000000123),
                     (${sFile}, ${libraryId}, ${rootId}, 'A/2.flac', 10, 1760000000)`;
    expect(await migrateAll(db.url)).toContain('0052_move_safe_files.sql');
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 2 });
    if (db) await admin.unsafe(`drop database if exists ${db.name} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
  });

  it('adds core_tags_digest and reconcile_hold_at', async () => {
    const cols = await sql`select column_name from information_schema.columns
                           where table_name = 'audio_files' and column_name in ('core_tags_digest', 'reconcile_hold_at') order by 1`;
    expect(cols.map((c) => c['column_name'])).toEqual(['core_tags_digest', 'reconcile_hold_at']);
  });

  it('turns millisecond mtimes into seconds and leaves seconds alone', async () => {
    const rows = await sql`select id, mtime::float8 as mtime from audio_files order by rel_path`;
    expect(rows.map((r) => r['mtime'])).toEqual([1760000000, 1760000000]);
  });

  it('deleting a file row deletes its embedded cover row instead of failing the origin check', async () => {
    const albumId = randomUUID();
    await sql`insert into local_albums (id, library_id, cluster_key) values (${albumId}, ${libraryId}, ${`k:${albumId}`})`;
    await sql`insert into images (library_id, entity_type, entity_id, local_album_id, kind, origin, audio_file_id, license_note)
              values (${libraryId}, 'local_album', ${albumId}, ${albumId}, 'front', 'embedded', ${sFile}, 't')`;
    await sql`delete from audio_files where id = ${sFile}`;
    expect((await sql`select count(*)::int as n from images where local_album_id = ${albumId}`)[0]!['n']).toBe(0);
  });

  it('deleting a sidecar row deletes its cover row', async () => {
    const albumId = randomUUID();
    const [sc] = await sql`insert into sidecar_files (library_id, scan_root_id, rel_path, kind) values (${libraryId}, ${rootId}, 'A/cover.jpg', 'image') returning id`;
    await sql`insert into local_albums (id, library_id, cluster_key) values (${albumId}, ${libraryId}, ${`k:${albumId}`})`;
    await sql`insert into images (library_id, entity_type, entity_id, local_album_id, kind, origin, sidecar_file_id, license_note)
              values (${libraryId}, 'local_album', ${albumId}, ${albumId}, 'front', 'sidecar', ${sc!['id']}, 't')`;
    await sql`delete from sidecar_files where id = ${sc!['id']}`;
    expect((await sql`select count(*)::int as n from images where local_album_id = ${albumId}`)[0]!['n']).toBe(0);
  });

  it('is safe to run twice', async () => {
    const file = (await import('node:fs/promises')).readFile;
    const { MIGRATIONS_DIR } = await import('@tagave/db');
    const text = await file(`${MIGRATIONS_DIR}/0052_move_safe_files.sql`, 'utf8');
    await sql.begin((tx) => tx.unsafe(text));
  });
});

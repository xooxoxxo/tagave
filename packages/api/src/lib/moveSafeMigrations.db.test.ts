/**
 * Move-safe scanning migrations: 0052 adds the reconcile columns, turns
 * millisecond mtimes into seconds, and lets a file's or sidecar's cover row
 * go with it; 0053 dedupes local_tracks and adds a NULLS NOT DISTINCT
 * unique key on (audio_file_id, cue_start_ms).
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

  it('creates the library-size and reconcile-hold indexes', async () => {
    const rows = await sql`select indexname from pg_indexes
                           where indexname in ('idx_audio_files_library_size', 'idx_audio_files_reconcile_hold') order by 1`;
    expect(rows.map((r) => r['indexname'])).toEqual(['idx_audio_files_library_size', 'idx_audio_files_reconcile_hold']);
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

describe.skipIf(!url)('0053 local_tracks unique key migration (integration)', () => {
  let admin: postgres.Sql;
  let db: { url: string; name: string };
  let sql: postgres.Sql;
  const ids = { lib: randomUUID(), root: randomUUID(), album: randomUUID(), file: randomUUID(), cue: randomUUID(), user: randomUUID() };
  const plain = { linked: randomUUID(), mapped: randomUUID(), bare: randomUUID() };
  let releaseCanonical: string;

  beforeAll(async () => {
    admin = postgres(url!, { max: 1, onnotice: () => undefined });
    db = await createScratchDb(url!, admin);
    await migrateUpTo(db.url, '0053');
    sql = postgres(db.url, { max: 2, onnotice: () => undefined });
    await sql`insert into users (id, email, display_name, password_hash) values (${ids.user}, ${`u-${ids.user}@test.com`}, 'U', 'x')`;
    await sql`insert into libraries (id, owner_user_id, name, settings) values (${ids.lib}, ${ids.user}, 'L', '{}')`;
    await sql`insert into scan_roots (id, library_id, path, display_name) values (${ids.root}, ${ids.lib}, '/music', 'm')`;
    await sql`insert into audio_files (id, library_id, scan_root_id, rel_path) values (${ids.file}, ${ids.lib}, ${ids.root}, 'A/1.flac'), (${ids.cue}, ${ids.lib}, ${ids.root}, 'A/img.flac')`;
    await sql`insert into local_albums (id, library_id, cluster_key) values (${ids.album}, ${ids.lib}, 'k')`;
    const [rg] = await sql`insert into release_groups (mbid, title) values (${randomUUID()}, 'RG') returning id`;
    const [rel] = await sql`insert into releases (release_group_id, mbid, title) values (${rg!['id']}, ${randomUUID()}, 'R') returning id`;
    const [ct] = await sql`insert into canonical_tracks (release_id, position, title) values (${rel!['id']}, 1, 'T') returning id`;
    releaseCanonical = ct!['id'] as string;
    // Three rows for one plain file (cue_start_ms NULL): one linked, one player-mapped, one bare.
    await sql`insert into local_tracks (id, local_album_id, audio_file_id, track_no, canonical_track_id) values
              (${plain.linked}, ${ids.album}, ${ids.file}, 1, ${releaseCanonical}),
              (${plain.mapped}, ${ids.album}, ${ids.file}, 1, null),
              (${plain.bare}, ${ids.album}, ${ids.file}, 1, null)`;
    await sql`insert into player_track_map (local_track_id, server_key, song_id, matched_by) values (${plain.mapped}, 'bundled', 's1', 'path')`;
    await sql`insert into player_plays (user_id, library_id, dedupe_key, source, local_track_id, title, started_at, heard, scrobbles)
              values (${ids.user}, ${ids.lib}, 'd1', 'web', ${plain.bare}, 'T', now(), true, false)`;
    const [rgUser] = await sql`select id from release_groups limit 1`;
    await sql`insert into user_reviews (library_id, user_id, release_group_id, favorite_track_ids)
              values (${ids.lib}, ${ids.user}, ${rgUser!['id']}, ${[plain.bare]}::uuid[])`;
    // Two cue tracks of one image file with distinct starts stay.
    await sql`insert into local_tracks (local_album_id, audio_file_id, track_no, origin, cue_start_ms) values
              (${ids.album}, ${ids.cue}, 1, 'cue', 0), (${ids.album}, ${ids.cue}, 2, 'cue', 180000)`;
    expect(await migrateAll(db.url)).toContain('0053_local_tracks_file_cue_unique.sql');
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 2 });
    if (db) await admin.unsafe(`drop database if exists ${db.name} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
  });

  it('keeps the linked row of a plain file and drops its twins', async () => {
    const rows = await sql`select id from local_tracks where audio_file_id = ${ids.file}`;
    expect(rows.map((r) => r['id'])).toEqual([plain.linked]);
  });

  it('re-points plays and favourites of a dropped twin to the kept row', async () => {
    expect((await sql`select local_track_id from player_plays where dedupe_key = 'd1'`)[0]!['local_track_id']).toBe(plain.linked);
    expect((await sql`select favorite_track_ids from user_reviews where user_id = ${ids.user}`)[0]!['favorite_track_ids']).toEqual([plain.linked]);
  });

  it('keeps cue tracks with different starts', async () => {
    expect((await sql`select count(*)::int as n from local_tracks where audio_file_id = ${ids.cue}`)[0]!['n']).toBe(2);
  });

  it('creates the unique index behind the constraint', async () => {
    const rows = await sql`select indexdef from pg_indexes where indexname = 'local_tracks_file_cue_key'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!['indexdef']).toMatch(/NULLS NOT DISTINCT/i);
  });

  it('refuses a second plain row for the same file (NULLS NOT DISTINCT)', async () => {
    await expect(sql`insert into local_tracks (audio_file_id) values (${ids.file})`).rejects.toThrow(/local_tracks_file_cue_key/);
  });

  it('ON CONFLICT (audio_file_id, cue_start_ms) finds the NULL row', async () => {
    const r = await sql`insert into local_tracks (audio_file_id, track_no) values (${ids.file}, 9)
                        on conflict (audio_file_id, cue_start_ms) do update set track_no = excluded.track_no returning id`;
    expect(r[0]!['id']).toBe(plain.linked);
  });
});

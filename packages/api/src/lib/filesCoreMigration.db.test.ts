/**
 * 0058 files core: a database migrated to 0057 with data in it is upgraded,
 * and every read gives the same answer through `files` as it gave through
 * `audio_files` before, and through the read-only `audio_files` view after.
 * The rename and the new `handler` column are catalogue changes: the table
 * keeps its storage (same relfilenode) and existing rows read 'audio' without
 * a rewrite.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '@tagave/db';
import { createScratchDb, migrateAll, migrateUpTo } from '../testkit/authApp.js';

const url = process.env.TEST_DATABASE_URL;

/** audio_files' columns at 0057, in table order. */
const OLD_COLUMNS = [
  'id', 'library_id', 'scan_root_id', 'rel_path', 'size_bytes', 'mtime', 'inode', 'container', 'codec', 'lossless', 'duration_ms',
  'sample_rate', 'bit_depth', 'channels', 'bitrate_kbps', 'has_embedded_art', 'tags_raw', 'tags_digest', 'tags_read_at',
  'audio_hash', 'audio_hash_at', 'fingerprint', 'fingerprint_duration', 'status', 'parse_error', 'first_seen_at', 'last_seen_at',
  'fingerprinted_at', 'fingerprint_error', 'core_tags_digest', 'reconcile_hold_at', 'missing_held_at',
];

describe.skipIf(!url)('0058 files core migration (upgrade from 0057 with data)', () => {
  let admin: postgres.Sql;
  let db: { url: string; name: string };
  let sql: postgres.Sql;
  const ids = { user: randomUUID(), lib: randomUUID(), root: randomUUID(), album: randomUUID(), plan: randomUUID() };
  const fileIds = Array.from({ length: 6 }, () => randomUUID());
  let rgId: string;
  let before: Record<string, unknown>;
  let filenodeBefore: string;
  let applied: string[];

  /** The reads compared across the upgrade; `t` is the relation the old code read. */
  const reads = async (t: string) => ({
    rows: await sql`select * from ${sql(t)} order by id`,
    byStatus: await sql`select status, count(*)::int as n, sum(size_bytes)::bigint as bytes from ${sql(t)} group by status order by status`,
    tracks: await sql`select lt.id, f.rel_path, f.status, f.duration_ms from local_tracks lt join ${sql(t)} f on f.id = lt.audio_file_id order by lt.id`,
    images: await sql`select i.id, f.rel_path from images i join ${sql(t)} f on f.id = i.audio_file_id order by i.id`,
    held: await sql`select id from ${sql(t)} where reconcile_hold_at is not null or missing_held_at is not null order by id`,
    unfingerprinted: await sql`select id from ${sql(t)} where library_id = ${ids.lib} and fingerprint is null and fingerprinted_at is null order by id`,
    digests: await sql`select id, tags_digest, core_tags_digest, tags_raw->'common'->>'title' as title from ${sql(t)} where core_tags_digest is null and tags_raw is not null order by id`,
    prefix: await sql`select rel_path from ${sql(t)} where scan_root_id = ${ids.root} and rel_path like 'A/%' order by rel_path`,
    collection: await sql`select facet_present('album.collection@1', ${ids.lib}::uuid, null::uuid, ${rgId}) as present`,
  });

  beforeAll(async () => {
    admin = postgres(url!, { max: 1, onnotice: () => undefined });
    db = await createScratchDb(url!, admin);
    await migrateUpTo(db.url, '0058');
    sql = postgres(db.url, { max: 2, onnotice: () => undefined });
    await sql`insert into users (id, email, display_name, password_hash) values (${ids.user}, ${`f-${ids.user}@test.com`}, 'F', 'x')`;
    await sql`insert into libraries (id, owner_user_id, name, settings) values (${ids.lib}, ${ids.user}, 'F', '{}')`;
    await sql`insert into scan_roots (id, library_id, path, display_name) values (${ids.root}, ${ids.lib}, '/music', 'm')`;
    const tags = (title: string) => JSON.stringify({ common: { title, artist: 'Artist', album: 'Album', track: { no: 1, of: 2 } }, native: {} });
    await sql`insert into audio_files (id, library_id, scan_root_id, rel_path, size_bytes, mtime, inode, container, codec, lossless,
                                       duration_ms, sample_rate, bit_depth, channels, bitrate_kbps, has_embedded_art, tags_raw,
                                       tags_digest, tags_read_at, core_tags_digest, audio_hash, status, parse_error,
                                       reconcile_hold_at, missing_held_at, fingerprint, fingerprinted_at)
              values (${fileIds[0]!}, ${ids.lib}, ${ids.root}, 'A/01 - One.flac', 1001, 1760000000, '66:1', 'FLAC', 'FLAC', true,
                      61000, 44100, 16, 2, 900, true, ${tags('One')}::text::jsonb, 'td1', now(), 'cd1', 'ah1', 'present', null, null, null, 'fp', now()),
                     (${fileIds[1]!}, ${ids.lib}, ${ids.root}, 'A/02 - Two.flac', 1002, 1760000000, '66:2', 'FLAC', 'FLAC', true,
                      62000, 44100, 16, 2, 900, false, ${tags('Two')}::text::jsonb, 'td2', now(), null, null, 'present', null, now(), null, null, null),
                     (${fileIds[2]!}, ${ids.lib}, ${ids.root}, 'A/03 - Gone.mp3', 1003, 1760000000, null, 'MPEG', 'MPEG 1 Layer 3', false,
                      63000, 44100, null, 2, 320, false, ${tags('Gone')}::text::jsonb, 'td3', now(), 'cd3', null, 'missing', null, null, now(), null, null),
                     (${fileIds[3]!}, ${ids.lib}, ${ids.root}, 'B/bad.flac', 5, 1760000000, '66:4', null, null, null,
                      null, null, null, null, null, false, null, null, null, null, null, 'error', 'Invalid FLAC preamble', null, null, null, null),
                     (${fileIds[4]!}, ${ids.lib}, ${ids.root}, 'B/new.flac', 7, 1760000001, '66:5', null, null, null,
                      null, null, null, null, null, false, null, null, null, null, null, 'present', null, null, null, null, null),
                     (${fileIds[5]!}, ${ids.lib}, ${ids.root}, 'C/Café.flac', 9, 1760000002, '66:6', 'FLAC', 'FLAC', true,
                      9000, 48000, 24, 2, 2000, false, ${tags('Café')}::text::jsonb, 'td6', now(), null, null, 'archived', null, null, null, null, null)`;
    const [rg] = await sql`insert into release_groups (mbid, title) values (${randomUUID()}, 'RG') returning id`;
    rgId = rg!['id'] as string;
    await sql`insert into local_albums (id, library_id, cluster_key, state, release_group_id) values (${ids.album}, ${ids.lib}, 'k-files', 'matched', ${rgId})`;
    await sql`insert into local_tracks (local_album_id, audio_file_id, track_no) values
              (${ids.album}, ${fileIds[0]!}, 1), (${ids.album}, ${fileIds[1]!}, 2), (${ids.album}, ${fileIds[2]!}, 3)`;
    await sql`insert into images (library_id, entity_type, entity_id, local_album_id, kind, origin, audio_file_id, license_note)
              values (${ids.lib}, 'local_album', ${ids.album}, ${ids.album}, 'front', 'embedded', ${fileIds[0]!}, 't')`;
    await sql`insert into tag_plans (id, library_id, name, scope, policy, status, created_by)
              values (${ids.plan}, ${ids.lib}, 'p', '{}'::jsonb, '{}'::jsonb, 'draft', ${ids.user})`;
    await sql`insert into tag_plan_items (tag_plan_id, audio_file_id, before, after, diff, status)
              values (${ids.plan}, ${fileIds[1]!}, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, 'pending')`;
    before = await reads('audio_files');
    filenodeBefore = ((await sql`select pg_relation_filenode('audio_files')::text as n`)[0]!['n']) as string;
    applied = await migrateAll(db.url);
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 2 });
    if (db) await admin.unsafe(`drop database if exists ${db.name} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
  });

  it('applies 0058 first on top of 0057', () => {
    expect(applied[0]).toBe('0058_files_core.sql');
  });

  it('renames the table in place: same storage, every row, no rewrite for handler', async () => {
    const [kinds] = await sql`select (select relkind::text from pg_class where relname = 'files' and relnamespace = 'public'::regnamespace) as files,
                                     (select relkind::text from pg_class where relname = 'audio_files' and relnamespace = 'public'::regnamespace) as audio_files`;
    expect(kinds).toEqual({ files: 'r', audio_files: 'v' });
    expect((await sql`select pg_relation_filenode('files')::text as n`)[0]!['n']).toBe(filenodeBefore);
    const [h] = await sql`select atthasmissing, attmissingval::text as missing from pg_attribute where attrelid = 'files'::regclass and attname = 'handler'`;
    expect(h).toEqual({ atthasmissing: true, missing: '{audio}' });
  });

  it('reads the same through files (old columns) as audio_files did before', async () => {
    const after = await reads('files');
    const strip = (rows: unknown) => (rows as Array<Record<string, unknown>>).map(({ handler: _h, media_type: _m, ...rest }) => rest);
    expect({ ...after, rows: strip(after.rows) }).toEqual(before);
    expect(Object.keys(after.rows[0] as object)).toEqual([...OLD_COLUMNS, 'handler', 'media_type']);
  });

  it('reads the same through the audio_files view, with exactly the old columns', async () => {
    const after = await reads('audio_files');
    expect(after).toEqual(before);
    expect(Object.keys(after.rows[0] as object)).toEqual(OLD_COLUMNS);
  });

  it('backfills handler audio and leaves media_type for the walk', async () => {
    expect(await sql`select handler, media_type, count(*)::int as n from files group by 1, 2`).toEqual([{ handler: 'audio', media_type: null, n: 6 }]);
  });

  it('gives the table its own names: keys, checks, indexes, trigger', async () => {
    const idx = (await sql`select indexname from pg_indexes where tablename = 'files' order by 1`).map((r) => r['indexname']);
    expect(idx).toEqual([
      'files_pkey', 'files_scan_root_id_rel_path_key', 'idx_files_digest_backfill', 'idx_files_library', 'idx_files_library_size',
      'idx_files_missing_held', 'idx_files_present_root', 'idx_files_reconcile_hold', 'idx_files_relpath_prefix', 'idx_files_scan_root',
      'idx_files_status', 'idx_files_unfingerprinted',
    ]);
    expect(await sql`select indexname from pg_indexes where indexname like '%audio\\_files%'`).toEqual([]);
    const cons = (await sql`select conname from pg_constraint where conrelid = 'files'::regclass order by 1`).map((r) => r['conname']);
    expect(cons).toEqual(['files_library_id_fkey', 'files_pkey', 'files_scan_root_id_fkey', 'files_scan_root_id_rel_path_key', 'files_status_check']);
    const [def] = await sql`select indexdef from pg_indexes where indexname = 'idx_files_digest_backfill'`;
    expect(def!['indexdef']).toMatch(/ON public\.files USING btree \(id\) WHERE \(\(core_tags_digest IS NULL\) AND \(tags_raw IS NOT NULL\)\)/);
    const triggers = (await sql`select tgname from pg_trigger where tgrelid = 'files'::regclass and not tgisinternal`).map((r) => r['tgname']);
    expect(triggers).toEqual(['facet_files_upd']);
    expect(await sql`select proname from pg_proc where proname in ('facet_trg_audio_files', 'facet_trg_files') order by 1`).toEqual([{ proname: 'facet_trg_files' }]);
  });

  it('keeps every foreign key to the file rows, now pointing at files', async () => {
    const fks = await sql`select conrelid::regclass::text as t, conname from pg_constraint where confrelid = 'files'::regclass order by 1`;
    expect(fks).toEqual([
      { t: 'cluster_overrides', conname: 'cluster_overrides_audio_file_id_fkey' },
      { t: 'images', conname: 'images_audio_file_id_fkey' },
      { t: 'local_tracks', conname: 'local_tracks_audio_file_id_fkey' },
      { t: 'tag_plan_items', conname: 'tag_plan_items_audio_file_id_fkey' },
    ]);
  });

  it('still logs album.collection@1 when a matched album\'s file goes missing (trigger and facet_present)', async () => {
    const count = async () => ((await sql`select count(*)::int as n from facet_changes where facet = 'album.collection@1' and key = ${rgId}`)[0]!['n']) as number;
    const n = await count();
    await sql`update files set status = 'missing' where id = ${fileIds[1]!}`;
    expect(await count()).toBe(n + 1);
    expect((await sql`select facet_present('album.collection@1', ${ids.lib}::uuid, null::uuid, ${rgId}) as p`)[0]!['p']).toBe(true);
    await sql`update files set status = 'present' where id = ${fileIds[1]!}`;
  });

  it('refuses a row without a handler', async () => {
    await expect(sql`insert into files (library_id, scan_root_id, rel_path) values (${ids.lib}, ${ids.root}, 'X/no-handler.flac')`)
      .rejects.toThrow(/null value in column "handler"/);
  });

  it('refuses writes through the audio_files view', async () => {
    const msg = /audio_files is a read-only view since 0058; write to files/;
    await expect(sql`insert into audio_files (library_id, scan_root_id, rel_path) values (${ids.lib}, ${ids.root}, 'X/v.flac')`).rejects.toThrow(msg);
    await expect(sql`update audio_files set status = 'missing' where id = ${fileIds[0]!}`).rejects.toThrow(msg);
    await expect(sql`delete from audio_files where id = ${fileIds[0]!}`).rejects.toThrow(msg);
    expect((await sql`select status from files where id = ${fileIds[0]!}`)[0]!['status']).toBe('present');
  });

  it('hides rows of other handlers from the audio_files view', async () => {
    const [row] = await sql`insert into files (library_id, scan_root_id, rel_path, handler, media_type) values (${ids.lib}, ${ids.root}, 'D/book.epub', 'epub', 'application/epub+zip') returning id`;
    expect(await sql`select id from audio_files where id = ${row!['id'] as string}`).toEqual([]);
    await sql`delete from files where id = ${row!['id'] as string}`;
  });

  it('is safe to run twice', async () => {
    const text = await readFile(`${MIGRATIONS_DIR}/0058_files_core.sql`, 'utf8');
    await sql.begin((tx) => tx.unsafe(text));
    expect((await reads('audio_files'))).toEqual(before);
  });
});

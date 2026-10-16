/**
 * Migration 0046 moves the thumbnails from images.thumb_bytes into
 * cover_thumbs: every byte arrives with its hash, the old column is emptied
 * (but kept), re-running the file changes nothing it already moved, and
 * deleting an image deletes its thumbnail.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, listMigrationFiles } from '@tagave/db';
import { createScratchDb, migrateAll, migrateUpTo } from '../testkit/authApp.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('0046 cover_thumbs migration (integration)', () => {
  let admin: postgres.Sql;
  let db: { url: string; name: string };
  let sql: postgres.Sql;
  let file: string;
  const thumbs = new Map<string, Buffer>();
  let bare: string;

  beforeAll(async () => {
    file = (await listMigrationFiles()).find((f) => /^\d{4}_cover_thumbs\.sql$/.test(f))!;
    expect(file).toBeTruthy();
    admin = postgres(url!, { max: 1, onnotice: () => undefined });
    db = await createScratchDb(url!, admin);
    await migrateUpTo(db.url, file.slice(0, 4));
    sql = postgres(db.url, { max: 2, onnotice: () => undefined });
    const userId = randomUUID();
    const libraryId = randomUUID();
    await sql`insert into users (id, email, display_name, password_hash) values (${userId}, ${`m-${userId}@test.com`}, 'M', 'x')`;
    await sql`insert into libraries (id, owner_user_id, name, settings) values (${libraryId}, ${userId}, 'M', '{}')`;
    for (let i = 0; i < 25; i++) {
      const albumId = randomUUID();
      await sql`insert into local_albums (id, library_id, cluster_key, dir_paths, title_guess)
                values (${albumId}, ${libraryId}, ${`m:${albumId}`}, ${[`M/${i}`]}, ${`M ${i}`})`;
      const bytes = randomBytes(2000 + i);
      const [img] = await sql`insert into images (library_id, entity_type, entity_id, local_album_id, kind, origin, license_note, thumb_bytes)
                values (${libraryId}, 'local_album', ${albumId}, ${albumId}, 'front', 'owner', 'test', ${i === 0 ? null : bytes}) returning id`;
      if (i === 0) bare = img!['id'] as string;
      else thumbs.set(img!['id'] as string, bytes);
    }
    expect(await migrateAll(db.url)).toContain(file);
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 2 });
    if (db) await admin.unsafe(`drop database if exists ${db.name} with (force)`).catch(() => undefined);
    await admin?.end({ timeout: 2 });
  });

  const rows = async () =>
    (await sql`select image_id, size, bytes, sha256 from cover_thumbs order by image_id`) as unknown as Array<{ image_id: string; size: number; bytes: Buffer; sha256: Buffer }>;

  it('copies every thumbnail with its hash and empties images.thumb_bytes, keeping the column', async () => {
    const got = await rows();
    expect(got).toHaveLength(thumbs.size);
    for (const r of got) {
      expect(r.size).toBe(300);
      expect(Buffer.from(r.bytes).equals(thumbs.get(r.image_id)!)).toBe(true);
      expect(Buffer.from(r.sha256).equals(createHash('sha256').update(thumbs.get(r.image_id)!).digest())).toBe(true);
    }
    expect(got.some((r) => r.image_id === bare)).toBe(false);
    expect((await sql`select count(*)::int as n from images where thumb_bytes is not null`)[0]!['n']).toBe(0);
    const col = await sql`select 1 from information_schema.columns where table_name = 'images' and column_name = 'thumb_bytes'`;
    expect(col).toHaveLength(1);
    const [storage] = await sql`select attstorage from pg_attribute where attrelid = 'cover_thumbs'::regclass and attname = 'bytes'`;
    expect(storage!['attstorage']).toBe('e');
  });

  it('is safe to run again: nothing moved twice, a thumbnail written to the old column since then moves too', async () => {
    const before = await rows();
    const body = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    await sql.unsafe(body);
    expect(await rows()).toEqual(before);
    // e.g. a restored pre-0046 dump: thumb_bytes filled again
    const late = randomBytes(1234);
    await sql`update images set thumb_bytes = ${late} where id = ${bare}`;
    await sql.unsafe(body);
    const after = await rows();
    expect(after).toHaveLength(before.length + 1);
    expect(Buffer.from(after.find((r) => r.image_id === bare)!.bytes).equals(late)).toBe(true);
    expect((await sql`select count(*)::int as n from images where thumb_bytes is not null`)[0]!['n']).toBe(0);
  });

  it('deleting an image deletes its thumbnail', async () => {
    await sql`delete from images where id = ${bare}`;
    expect((await sql`select count(*)::int as n from cover_thumbs where image_id = ${bare}`)[0]!['n']).toBe(0);
  });
});

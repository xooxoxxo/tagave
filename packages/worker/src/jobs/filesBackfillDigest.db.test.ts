import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { makeDb } from '@tagave/db';
import type { WorkerContext } from '../lib/context.js';
import { coreTagsDigest } from '../lib/helpers.js';
import { filesBackfillDigestJob } from './filesBackfillDigest.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('files.backfillDigest (db)', () => {
  let ctx: WorkerContext; let sql: any;
  const userId = randomUUID(); const libraryId = randomUUID(); const rootId = randomUUID();
  const raw = { common: { title: 'Ghost', artist: 'Artist', album: 'Album One', track: { no: 1 } } };

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    sql = made.client;
    ctx = { db: made.db, sql: made.client, boss: { send: async () => randomUUID() } as any, logger: pino({ level: 'silent' }) };
    await sql`insert into users (id, email, password_hash) values (${userId}, ${`bf-${userId}@test.com`}, 'x')`;
    await sql`insert into libraries (id, name, owner_user_id, settings) values (${libraryId}, 'BF', ${userId}, '{}')`;
    await sql`insert into scan_roots (id, library_id, path, display_name) values (${rootId}, ${libraryId}, '/nonexistent-bf', 'bf')`;
    for (let i = 0; i < 5; i++) {
      await sql`insert into audio_files (library_id, scan_root_id, rel_path, status, tags_raw)
                values (${libraryId}, ${rootId}, ${`G/${i}.flac`}, ${i % 2 ? 'missing' : 'present'}, ${JSON.stringify(raw)}::text::jsonb)`;
    }
    await sql`insert into audio_files (library_id, scan_root_id, rel_path, tags_raw) values (${libraryId}, ${rootId}, 'G/untagged.flac', ${JSON.stringify({ common: {} })}::text::jsonb)`;
  });

  afterAll(async () => {
    await sql`delete from scan_roots where id = ${rootId}`;
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
  });

  it('fills every tagged row, missing ones included, in small batches, and stops', async () => {
    const r = await filesBackfillDigestJob(ctx, { batch: 2 });
    expect(r.updated).toBeGreaterThanOrEqual(5);
    const rows = await sql`select rel_path, core_tags_digest from audio_files where scan_root_id = ${rootId} order by rel_path`;
    for (const row of rows) expect(row.core_tags_digest).toBe(row.rel_path === 'G/untagged.flac' ? null : coreTagsDigest(raw));
    expect((await filesBackfillDigestJob(ctx, { batch: 2 })).updated).toBe(0);
  });
});

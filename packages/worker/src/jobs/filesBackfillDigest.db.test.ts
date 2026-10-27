import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { makeDb } from '@tagave/db';
import type { WorkerContext } from '../lib/context.js';
import { coreTagsDigest } from '@tagave/core/files';
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
      await sql`insert into files (library_id, scan_root_id, rel_path, status, tags_raw, handler)
                values (${libraryId}, ${rootId}, ${`G/${i}.flac`}, ${i % 2 ? 'missing' : 'present'}, ${JSON.stringify(raw)}::text::jsonb, 'audio')`;
    }
    await sql`insert into files (library_id, scan_root_id, rel_path, tags_raw, handler) values (${libraryId}, ${rootId}, 'G/untagged.flac', ${JSON.stringify({ common: {} })}::text::jsonb, 'audio')`;
  });

  afterAll(async () => {
    await sql`delete from scan_roots where id = ${rootId}`;
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
  });

  /** ctx.sql that records the ids each backfill select returned and can run a hook after it. */
  const watched = (onSelect?: (ids: string[]) => Promise<void>) => {
    const seen: string[] = [];
    const fn = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const res = await sql(strings, ...values);
      if (strings.join('?').includes('select id, tags_raw')) {
        const ids = (res as Array<{ id: string }>).map((r) => r.id);
        for (const id of ids) seen.push(id);
        if (onSelect) await onSelect(ids);
      }
      return res;
    }) as any;
    return { fn, seen };
  };
  const mine = async () => (await sql`select id from files where scan_root_id = ${rootId}`).map((r: any) => r.id as string);

  it('fills every tagged row, missing ones included, in small batches, and stops', async () => {
    // other test files share this database: counts are taken on this file's rows only
    await filesBackfillDigestJob(ctx, { batch: 2 });
    const rows = await sql`select rel_path, status, core_tags_digest from files where scan_root_id = ${rootId} order by rel_path`;
    expect(rows).toHaveLength(6);
    for (const row of rows) expect(row.core_tags_digest).toBe(row.rel_path === 'G/untagged.flac' ? null : coreTagsDigest(raw));
    expect(rows.filter((r: any) => r.core_tags_digest !== null && r.status === 'missing')).toHaveLength(2);
    // a second run reads none of the filled rows again, only the untagged one
    const w = watched();
    await filesBackfillDigestJob({ ...ctx, sql: w.fn }, { batch: 2 });
    const ids = new Set(await mine());
    const reread = w.seen.filter((id) => ids.has(id));
    const [untagged] = await sql`select id from files where scan_root_id = ${rootId} and rel_path = 'G/untagged.flac'`;
    expect(reread).toEqual([untagged.id]);
  });

  it('does not write a digest when the tags changed between its read and its write', async () => {
    const [stale] = await sql`insert into files (library_id, scan_root_id, rel_path, tags_raw, tags_digest, handler)
      values (${libraryId}, ${rootId}, 'R/stale.flac', ${JSON.stringify(raw)}::text::jsonb, 'before', 'audio') returning id`;
    const [kept] = await sql`insert into files (library_id, scan_root_id, rel_path, tags_raw, tags_digest, handler)
      values (${libraryId}, ${rootId}, 'R/kept.flac', ${JSON.stringify(raw)}::text::jsonb, 'before', 'audio') returning id`;
    // a parse lands mid-batch: new tags (no core fields), so core_tags_digest stays null
    let raced = false;
    const w = watched(async (ids) => {
      if (!raced && ids.includes(stale.id)) {
        raced = true;
        await sql`update files set tags_raw = ${JSON.stringify({ common: {} })}::text::jsonb, tags_digest = 'after' where id = ${stale.id}`;
      }
    });
    await filesBackfillDigestJob({ ...ctx, sql: w.fn }, { batch: 1000 });
    expect(raced).toBe(true);
    const digestOf = async (id: string) => (await sql`select core_tags_digest from files where id = ${id}`)[0].core_tags_digest;
    expect(await digestOf(stale.id)).toBeNull();
    expect(await digestOf(kept.id)).toBe(coreTagsDigest(raw));
  });
});

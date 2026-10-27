import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { makeDb } from '@tagave/db';
import type { WorkerContext } from '../lib/context.js';
import { coreTagsDigest } from '@tagave/core/files';
import { writeFlac } from '../testkit/flac.js';
import { scanParseJob } from './scanParse.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('scan.parse stores the core tag digest (db)', () => {
  let ctx: WorkerContext; let sql: any; let rootPath: string;
  const userId = randomUUID(); const libraryId = randomUUID(); const rootId = randomUUID(); const fileId = randomUUID();

  beforeAll(async () => {
    const made = await makeDb(process.env.TEST_DATABASE_URL!);
    sql = made.client;
    ctx = { db: made.db, sql: made.client, boss: { send: async () => randomUUID() } as any, logger: pino({ level: 'silent' }) };
    rootPath = await mkdtemp(path.join(tmpdir(), 'tagave-parse-'));
    await writeFlac(path.join(rootPath, '1.flac'), { title: 'Song', artist: 'Artist', album: 'Album One', track: 1, seconds: 10 });
    await sql`insert into users (id, email, password_hash) values (${userId}, ${`sp-${userId}@test.com`}, 'x')`;
    await sql`insert into libraries (id, name, owner_user_id, settings) values (${libraryId}, 'SP', ${userId}, '{}')`;
    await sql`insert into scan_roots (id, library_id, path, display_name) values (${rootId}, ${libraryId}, ${rootPath}, 'sp')`;
    await sql`insert into files (id, library_id, scan_root_id, rel_path, handler) values (${fileId}, ${libraryId}, ${rootId}, '1.flac', 'audio')`;
  });

  afterAll(async () => {
    await sql`delete from scan_roots where id = ${rootId}`;
    await sql`delete from libraries where id = ${libraryId}`;
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
    await rm(rootPath, { recursive: true, force: true });
  });

  it('writes core_tags_digest next to tags_digest', async () => {
    await scanParseJob(ctx, { audioFileIds: [fileId] });
    const [r] = await sql`select tags_raw, core_tags_digest, duration_ms from files where id = ${fileId}`;
    expect(r.core_tags_digest).toMatch(/^[0-9a-f]{40}$/);
    expect(r.core_tags_digest).toBe(coreTagsDigest(r.tags_raw));
    expect(r.duration_ms).toBe(10_000);
  });

  it('a file whose parse error quotes NUL bytes is stored as error (NULs stripped), not a failed job', async () => {
    const zeros = randomUUID();
    await writeFile(path.join(rootPath, 'zeros.flac'), Buffer.alloc(64));
    await sql`insert into files (id, library_id, scan_root_id, rel_path, handler) values (${zeros}, ${libraryId}, ${rootId}, 'zeros.flac', 'audio')`;
    await scanParseJob(ctx, { audioFileIds: [zeros] });
    const [r] = await sql`select status, parse_error from files where id = ${zeros}`;
    expect(r.status).toBe('error');
    expect(r.parse_error).toMatch(/\S/);
    expect(r.parse_error).not.toContain('\u0000');
  });
});
